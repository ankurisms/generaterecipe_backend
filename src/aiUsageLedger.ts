import { DurableObject } from "cloudflare:workers";

type ProviderName = "openrouter" | "cloudflare_workers_ai";
type UsageStatus = "started" | "succeeded" | "failed" | "usage_pending";
type JobStatus = "reserved" | "processing" | "completed" | "failed" | "usage_pending";

type JobRow = {
	job_id: string;
	idempotency_hash: string;
	status: JobStatus;
	terminal_status: "completed" | "failed" | null;
	created_at: string;
	updated_at: string;
	estimated_micros: number;
	actual_micros: number;
	reserved_micros: number;
};

const MICRO_USD = 1_000_000;
const UNSTARTED_RESERVATION_TTL_MS = 5 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function moneyToMicros(value: unknown): number | null {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		value > 1_000_000
	) {
		return null;
	}
	return Math.ceil(value * MICRO_USD);
}

function microsToMoney(value: number | null): number | null {
	return value === null ? null : value / MICRO_USD;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

export class AIUsageLedger extends DurableObject {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS jobs (
				job_id TEXT PRIMARY KEY,
				idempotency_hash TEXT NOT NULL UNIQUE,
				status TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				estimated_micros INTEGER NOT NULL,
				actual_micros INTEGER NOT NULL DEFAULT 0,
				reserved_micros INTEGER NOT NULL DEFAULT 0,
				terminal_status TEXT
			);
			CREATE TABLE IF NOT EXISTS provider_usage (
				operation_id TEXT PRIMARY KEY,
				job_id TEXT NOT NULL,
				provider TEXT NOT NULL,
				model TEXT NOT NULL,
				audio_duration_ms INTEGER,
				input_tokens INTEGER,
				output_tokens INTEGER,
				estimated_micros INTEGER NOT NULL,
				actual_micros INTEGER,
				status TEXT NOT NULL,
				provider_reference TEXT,
				attempt_count INTEGER NOT NULL DEFAULT 1,
				started_at TEXT NOT NULL,
				completed_at TEXT
			);
			CREATE INDEX IF NOT EXISTS provider_usage_job_id
				ON provider_usage(job_id);
			CREATE INDEX IF NOT EXISTS jobs_updated_at
				ON jobs(updated_at);
			CREATE TABLE IF NOT EXISTS usage_reconciliations (
				operation_id TEXT PRIMARY KEY,
				reconciled_at TEXT NOT NULL,
				source TEXT NOT NULL
			);
		`);
		const jobColumns = ctx.storage.sql
			.exec("PRAGMA table_info(jobs)")
			.toArray() as Array<{ name: string }>;
		if (!jobColumns.some((column) => column.name === "terminal_status")) {
			ctx.storage.sql.exec("ALTER TABLE jobs ADD COLUMN terminal_status TEXT");
		}
	}

	async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		try {
			if (request.method === "POST" && pathname === "/reserve") {
				return this.reserve(await request.json());
			}
			if (request.method === "POST" && pathname === "/usage") {
				return this.recordUsage(await request.json());
			}
			if (request.method === "POST" && pathname === "/finish") {
				return this.finish(await request.json());
			}
			if (request.method === "POST" && pathname === "/reconcile") {
				return this.reconcile(await request.json());
			}
			if (request.method === "POST" && pathname === "/sweep") {
				const value: unknown = await request.json();
				const now =
					isRecord(value) && typeof value.now === "string"
						? new Date(value.now)
						: new Date();
				if (Number.isNaN(now.getTime())) {
					return jsonResponse({ error: "invalid_request" }, 400);
				}
				this.sweepExpiredReservations(now);
				return jsonResponse({ accepted: true });
			}
			if (request.method === "GET" && pathname === "/summary") {
				const url = new URL(request.url);
				const limit = Number(url.searchParams.get("limit") ?? "25");
				const budgetLimitUsd = Number(url.searchParams.get("budgetLimitUsd"));
				const reserveUsd = Number(url.searchParams.get("reserveUsd"));
				if (
					!Number.isInteger(limit) ||
					limit < 1 ||
					limit > 100 ||
					moneyToMicros(budgetLimitUsd) === null ||
					moneyToMicros(reserveUsd) === null
				) {
					return jsonResponse({ error: "invalid_summary_parameters" }, 400);
				}
				return this.summary(limit, budgetLimitUsd, reserveUsd);
			}
			return jsonResponse({ error: "not_found" }, 404);
		} catch {
			return jsonResponse({ error: "invalid_ledger_request" }, 400);
		}
	}

	private reserve(value: unknown): Response {
		if (!isRecord(value)) return jsonResponse({ error: "invalid_request" }, 400);
		const { idempotencyHash } = value;
		const estimatedMicros = moneyToMicros(value.estimatedCostUsd);
		const budgetLimitMicros = moneyToMicros(value.budgetLimitUsd);
		const reserveMicros = moneyToMicros(value.reserveUsd);
		if (
			typeof idempotencyHash !== "string" ||
			!/^[a-f0-9]{64}$/.test(idempotencyHash) ||
			estimatedMicros === null ||
			estimatedMicros === 0 ||
			budgetLimitMicros === null ||
			reserveMicros === null ||
			reserveMicros > budgetLimitMicros
		) {
			return jsonResponse({ error: "invalid_request" }, 400);
		}

		const result = this.ctx.storage.transactionSync(() => {
			this.sweepExpiredReservations(new Date());
			const existing = this.ctx.storage.sql
				.exec(
					"SELECT job_id, status FROM jobs WHERE idempotency_hash = ?",
					idempotencyHash,
				)
				.toArray()[0] as Pick<JobRow, "job_id" | "status"> | undefined;
			if (existing) {
				return {
					accepted: false,
					reason: "duplicate",
					jobId: existing.job_id,
					status: existing.status,
				};
			}

			const totals = this.ctx.storage.sql
				.exec(
					"SELECT COALESCE(SUM(actual_micros), 0) AS actual, COALESCE(SUM(reserved_micros), 0) AS reserved FROM jobs",
				)
				.one() as { actual: number; reserved: number };
			const usableLimit = budgetLimitMicros - reserveMicros;
			if (totals.actual + totals.reserved + estimatedMicros > usableLimit) {
				return { accepted: false, reason: "budget_exhausted" };
			}

			const jobId = crypto.randomUUID();
			const timestamp = new Date().toISOString();
			this.ctx.storage.sql.exec(
				"INSERT INTO jobs (job_id, idempotency_hash, status, created_at, updated_at, estimated_micros, reserved_micros) VALUES (?, ?, 'reserved', ?, ?, ?, ?)",
				jobId,
				idempotencyHash,
				timestamp,
				timestamp,
				estimatedMicros,
				estimatedMicros,
			);
			return {
				accepted: true,
				jobId,
				status: "reserved",
				estimatedCostUsd: microsToMoney(estimatedMicros),
			};
		});
		const status = result.accepted
			? 201
			: result.reason === "budget_exhausted"
				? 429
				: 409;
		return jsonResponse(result, status);
	}

	private recordUsage(value: unknown): Response {
		if (!isRecord(value)) return jsonResponse({ error: "invalid_request" }, 400);
		const estimatedMicros = moneyToMicros(value.estimatedCostUsd);
		const actualMicros =
			value.actualCostUsd === null ? null : moneyToMicros(value.actualCostUsd);
		if (
			typeof value.jobId !== "string" ||
			typeof value.operationId !== "string" ||
			!/^[a-f0-9-]{36}$/.test(value.jobId) ||
			!/^[a-f0-9-]{36}$/.test(value.operationId) ||
			(value.provider !== "openrouter" &&
				value.provider !== "cloudflare_workers_ai") ||
			typeof value.model !== "string" ||
			!value.model.trim() ||
			value.model.length > 160 ||
			estimatedMicros === null ||
			actualMicros === undefined ||
			(value.actualCostUsd !== null && actualMicros === null) ||
			!["started", "succeeded", "failed", "usage_pending"].includes(
				String(value.status),
			) ||
			!optionalNonNegativeInteger(value.audioDurationMs) ||
			!optionalNonNegativeInteger(value.inputTokens) ||
			!optionalNonNegativeInteger(value.outputTokens) ||
			(value.providerReference !== undefined &&
				value.providerReference !== null &&
				(typeof value.providerReference !== "string" ||
					value.providerReference.length > 200)) ||
			(value.attemptCount !== undefined &&
				(!Number.isInteger(value.attemptCount) ||
					Number(value.attemptCount) < 1 ||
					Number(value.attemptCount) > 2))
		) {
			return jsonResponse({ error: "invalid_request" }, 400);
		}

		const now = new Date().toISOString();
		const status = value.status as UsageStatus;
		const model = value.model.trim();
		const operationStatus =
			actualMicros === null && status === "succeeded"
				? "usage_pending"
				: status;
		const result = this.ctx.storage.transactionSync(() => {
			const job = this.ctx.storage.sql
				.exec("SELECT * FROM jobs WHERE job_id = ?", value.jobId)
				.toArray()[0] as JobRow | undefined;
			if (!job) return { accepted: false, reason: "job_not_found" };
			if (
				job.status === "completed" ||
				job.status === "failed" ||
				job.terminal_status !== null
			) {
				return { accepted: false, reason: "job_closed" };
			}

			const priorOperation = this.ctx.storage.sql
				.exec(
					"SELECT job_id, provider FROM provider_usage WHERE operation_id = ?",
					value.operationId,
				)
				.toArray()[0] as { job_id: string; provider: ProviderName } | undefined;
			if (
				priorOperation &&
				(priorOperation.job_id !== value.jobId ||
					priorOperation.provider !== value.provider)
			) {
				return { accepted: false, reason: "operation_conflict" };
			}
			const priorEstimate = this.ctx.storage.sql
				.exec(
					"SELECT estimated_micros FROM provider_usage WHERE operation_id = ?",
					value.operationId,
				)
				.toArray()[0] as { estimated_micros: number } | undefined;
			const recordedEstimate = Math.max(
				priorEstimate?.estimated_micros ?? 0,
				estimatedMicros,
			);
			const operationEstimates = this.ctx.storage.sql
				.exec(
					"SELECT COALESCE(SUM(estimated_micros), 0) AS total FROM provider_usage WHERE job_id = ?",
					value.jobId,
				)
				.one() as { total: number };
			if (
				operationEstimates.total -
					(priorEstimate?.estimated_micros ?? 0) +
					recordedEstimate >
				job.estimated_micros
			) {
				return { accepted: false, reason: "reservation_exceeded" };
			}

			const completedAt = actualMicros === null ? null : now;
			this.ctx.storage.sql.exec(
				`INSERT INTO provider_usage (
					operation_id, job_id, provider, model, audio_duration_ms,
					input_tokens, output_tokens, estimated_micros, actual_micros,
					status, provider_reference, attempt_count, started_at, completed_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(operation_id) DO UPDATE SET
					provider = provider_usage.provider,
					model = CASE WHEN excluded.model = 'unknown'
						THEN provider_usage.model ELSE excluded.model END,
					audio_duration_ms = COALESCE(excluded.audio_duration_ms, provider_usage.audio_duration_ms),
					input_tokens = COALESCE(excluded.input_tokens, provider_usage.input_tokens),
					output_tokens = COALESCE(excluded.output_tokens, provider_usage.output_tokens),
					estimated_micros = MAX(provider_usage.estimated_micros, excluded.estimated_micros),
					actual_micros = COALESCE(provider_usage.actual_micros, excluded.actual_micros),
					status = CASE WHEN provider_usage.actual_micros IS NULL
						THEN excluded.status ELSE provider_usage.status END,
					provider_reference = COALESCE(excluded.provider_reference, provider_usage.provider_reference),
					attempt_count = MAX(provider_usage.attempt_count, excluded.attempt_count),
					started_at = provider_usage.started_at,
					completed_at = COALESCE(provider_usage.completed_at, excluded.completed_at)`,
				value.operationId,
				value.jobId,
				value.provider,
				model,
				value.audioDurationMs ?? null,
				value.inputTokens ?? null,
				value.outputTokens ?? null,
				recordedEstimate,
				actualMicros,
				operationStatus,
				value.providerReference ?? null,
				value.attemptCount ?? 1,
				now,
				completedAt,
			);

			const totals = this.ctx.storage.sql
				.exec(
					"SELECT COALESCE(SUM(COALESCE(actual_micros, 0)), 0) AS actual, COALESCE(SUM(CASE WHEN actual_micros IS NOT NULL THEN estimated_micros ELSE 0 END), 0) AS reconciled_estimate FROM provider_usage WHERE job_id = ?",
					value.jobId,
				)
				.one() as { actual: number; reconciled_estimate: number };
			const reservedMicros = Math.max(
				0,
				job.estimated_micros - totals.reconciled_estimate,
			);
			this.ctx.storage.sql.exec(
				"UPDATE jobs SET status = ?, actual_micros = ?, reserved_micros = ?, updated_at = ? WHERE job_id = ?",
				operationStatus === "started"
					? "processing"
					: reservedMicros > 0
						? "usage_pending"
						: "processing",
				totals.actual,
				reservedMicros,
				now,
				value.jobId,
			);
			return {
				accepted: true,
				actualCostUsd: microsToMoney(actualMicros),
				status: operationStatus,
			};
		});
		return jsonResponse(result, result.accepted ? 200 : 404);
	}

	private finish(value: unknown): Response {
		if (
			!isRecord(value) ||
			typeof value.jobId !== "string" ||
			!/^[a-f0-9-]{36}$/.test(value.jobId) ||
			(value.status !== "completed" && value.status !== "failed") ||
			(value.holdReservation !== undefined &&
				typeof value.holdReservation !== "boolean")
		) {
			return jsonResponse({ error: "invalid_request" }, 400);
		}

		const now = new Date().toISOString();
		const requestedStatus = value.status as "completed" | "failed";
		const result = this.ctx.storage.transactionSync(() => {
			const job = this.ctx.storage.sql
				.exec("SELECT * FROM jobs WHERE job_id = ?", value.jobId)
				.toArray()[0] as JobRow | undefined;
			if (!job) return { accepted: false, reason: "job_not_found" };
			if (job.status === "completed" || job.status === "failed") {
				return {
					accepted: true,
					jobId: job.job_id,
					status: job.status,
					estimatedCostUsd: microsToMoney(job.estimated_micros),
					actualCostUsd: microsToMoney(job.actual_micros),
					reservedCostUsd: microsToMoney(job.reserved_micros),
				};
			}

			const usage = this.ctx.storage.sql
				.exec(
					"SELECT COUNT(*) AS pending FROM provider_usage WHERE job_id = ? AND actual_micros IS NULL",
					value.jobId,
				)
				.one() as { pending: number };
			const holdReservation =
				value.holdReservation === true || usage.pending > 0;
			const terminalStatus = job.terminal_status ?? requestedStatus;
			const status: JobStatus = holdReservation
				? "usage_pending"
				: requestedStatus;
			this.ctx.storage.sql.exec(
				"UPDATE jobs SET status = ?, terminal_status = ?, reserved_micros = ?, updated_at = ? WHERE job_id = ?",
				status,
				holdReservation ? terminalStatus : null,
				holdReservation ? job.reserved_micros : 0,
				now,
				value.jobId,
			);
			return {
				accepted: true,
				jobId: job.job_id,
				status,
				estimatedCostUsd: microsToMoney(job.estimated_micros),
				actualCostUsd: microsToMoney(job.actual_micros),
				reservedCostUsd: microsToMoney(
					holdReservation ? job.reserved_micros : 0,
				),
			};
		});
		return jsonResponse(result, result.accepted ? 200 : 404);
	}

	private reconcile(value: unknown): Response {
		const actualMicros =
			isRecord(value) && typeof value.actualCostUsd === "number"
				? moneyToMicros(value.actualCostUsd)
				: null;
		if (
			!isRecord(value) ||
			typeof value.operationId !== "string" ||
			!/^[a-f0-9-]{36}$/.test(value.operationId) ||
			actualMicros === null ||
			(value.status !== "succeeded" && value.status !== "failed")
		) {
			return jsonResponse({ error: "invalid_request" }, 400);
		}

		const now = new Date().toISOString();
		const result = this.ctx.storage.transactionSync(() => {
			const usage = this.ctx.storage.sql
				.exec(
					"SELECT job_id, actual_micros FROM provider_usage WHERE operation_id = ?",
					value.operationId,
				)
				.toArray()[0] as
				| { job_id: string; actual_micros: number | null }
				| undefined;
			if (!usage) return { accepted: false, reason: "operation_not_found" };
			if (usage.actual_micros !== null) {
				return { accepted: false, reason: "already_reconciled" };
			}

			const job = this.ctx.storage.sql
				.exec("SELECT * FROM jobs WHERE job_id = ?", usage.job_id)
				.toArray()[0] as JobRow | undefined;
			if (!job) return { accepted: false, reason: "job_not_found" };
			if (job.status !== "usage_pending" || job.terminal_status === null) {
				return { accepted: false, reason: "job_not_pending" };
			}

			this.ctx.storage.sql.exec(
				"UPDATE provider_usage SET actual_micros = ?, status = ?, completed_at = ? WHERE operation_id = ? AND actual_micros IS NULL",
				actualMicros,
				value.status,
				now,
				value.operationId,
			);
			this.ctx.storage.sql.exec(
				"INSERT INTO usage_reconciliations (operation_id, reconciled_at, source) VALUES (?, ?, 'admin')",
				value.operationId,
				now,
			);

			const totals = this.ctx.storage.sql
				.exec(
					`SELECT COALESCE(SUM(COALESCE(actual_micros, 0)), 0) AS actual,
						COALESCE(SUM(CASE WHEN actual_micros IS NOT NULL THEN estimated_micros ELSE 0 END), 0) AS reconciled_estimate,
						COUNT(*) FILTER (WHERE actual_micros IS NULL) AS pending
					FROM provider_usage WHERE job_id = ?`,
					usage.job_id,
				)
				.one() as {
				actual: number;
				reconciled_estimate: number;
				pending: number;
			};
			const allSettled = totals.pending === 0;
			const status = allSettled ? job.terminal_status : "usage_pending";
			const reservedMicros = allSettled
				? 0
				: Math.max(0, job.estimated_micros - totals.reconciled_estimate);
			this.ctx.storage.sql.exec(
				"UPDATE jobs SET status = ?, terminal_status = ?, actual_micros = ?, reserved_micros = ?, updated_at = ? WHERE job_id = ?",
				status,
				allSettled ? null : job.terminal_status,
				totals.actual,
				reservedMicros,
				now,
				usage.job_id,
			);
			return {
				accepted: true,
				status,
				actualCostUsd: microsToMoney(actualMicros),
				jobActualCostUsd: microsToMoney(totals.actual),
				reservedCostUsd: microsToMoney(reservedMicros),
			};
		});
		const httpStatus = result.accepted
			? 200
			: result.reason === "operation_not_found" || result.reason === "job_not_found"
				? 404
				: result.reason === "already_reconciled" ||
						result.reason === "job_not_pending"
					? 409
					: 400;
		return jsonResponse(result, httpStatus);
	}

	private sweepExpiredReservations(now: Date): void {
		const cutoff = new Date(
			now.getTime() - UNSTARTED_RESERVATION_TTL_MS,
		).toISOString();
		this.ctx.storage.sql.exec(
			`UPDATE jobs
			SET status = 'failed', terminal_status = 'failed',
				reserved_micros = 0, updated_at = ?
			WHERE status = 'reserved' AND created_at < ?
				AND NOT EXISTS (
					SELECT 1 FROM provider_usage
					WHERE provider_usage.job_id = jobs.job_id
				)`,
			now.toISOString(),
			cutoff,
		);
	}

	private summary(
		limit: number,
		budgetLimitUsd: number,
		reserveUsd: number,
	): Response {
		this.sweepExpiredReservations(new Date());
		const totals = this.ctx.storage.sql
			.exec(
				"SELECT COUNT(*) AS jobs, COALESCE(SUM(actual_micros), 0) AS actual, COALESCE(SUM(reserved_micros), 0) AS reserved FROM jobs",
			)
			.one() as { jobs: number; actual: number; reserved: number };
		const byProvider = this.ctx.storage.sql
			.exec(
				`SELECT provider,
					COUNT(*) AS operations,
					COALESCE(SUM(audio_duration_ms), 0) AS audio_duration_ms,
					COALESCE(SUM(input_tokens), 0) AS input_tokens,
					COALESCE(SUM(output_tokens), 0) AS output_tokens,
					COALESCE(SUM(estimated_micros), 0) AS estimated_micros,
					SUM(actual_micros) AS actual_micros
				FROM provider_usage GROUP BY provider`,
			)
			.toArray() as Array<{
			provider: ProviderName;
			operations: number;
			audio_duration_ms: number;
			input_tokens: number;
			output_tokens: number;
			estimated_micros: number;
			actual_micros: number | null;
		}>;
		const jobs = this.ctx.storage.sql
			.exec(
				`SELECT job_id, status, created_at, updated_at, estimated_micros,
					actual_micros, reserved_micros
				FROM jobs ORDER BY created_at DESC LIMIT ?`,
				limit,
			)
			.toArray() as Array<
			Omit<JobRow, "idempotency_hash">
		>;
		const recentUsage = this.ctx.storage.sql
			.exec(
				`SELECT operation_id, job_id, provider, model, audio_duration_ms,
					input_tokens, output_tokens, estimated_micros, actual_micros,
					status, provider_reference, attempt_count, started_at, completed_at,
					EXISTS (
						SELECT 1 FROM usage_reconciliations
						WHERE usage_reconciliations.operation_id = provider_usage.operation_id
					) AS manually_reconciled
				FROM provider_usage ORDER BY started_at DESC LIMIT ?`,
				limit * 4,
			)
			.toArray() as Array<{
			operation_id: string;
			job_id: string;
			provider: ProviderName;
			model: string;
			audio_duration_ms: number | null;
			input_tokens: number | null;
			output_tokens: number | null;
			estimated_micros: number;
			actual_micros: number | null;
			status: UsageStatus;
			provider_reference: string | null;
			attempt_count: number;
			started_at: string;
			completed_at: string | null;
			manually_reconciled: number;
		}>;
		const usableLimit = Math.max(0, budgetLimitUsd - reserveUsd);
		const spent = microsToMoney(totals.actual) ?? 0;
		const reserved = microsToMoney(totals.reserved) ?? 0;

		return jsonResponse({
			budget: {
				limit_usd: budgetLimitUsd,
				reserved_for_demo_usd: reserveUsd,
				usable_limit_usd: usableLimit,
				actual_spend_usd: spent,
				reserved_spend_usd: reserved,
				available_usd: Math.max(0, usableLimit - spent - reserved),
			},
			totals: {
				jobs: totals.jobs,
				actual_spend_usd: spent,
				reserved_spend_usd: reserved,
			},
			providers: byProvider.map((row) => ({
				provider: row.provider,
				operations: row.operations,
				audio_duration_seconds: row.audio_duration_ms / 1_000,
				input_tokens: row.input_tokens,
				output_tokens: row.output_tokens,
				estimated_cost_usd: microsToMoney(row.estimated_micros),
				actual_cost_usd: microsToMoney(row.actual_micros),
			})),
			recent_jobs: jobs.map((job) => ({
				job_id: job.job_id,
				status: job.status,
				created_at: job.created_at,
				updated_at: job.updated_at,
				estimated_cost_usd: microsToMoney(job.estimated_micros),
				actual_cost_usd: microsToMoney(job.actual_micros),
				reserved_cost_usd: microsToMoney(job.reserved_micros),
			})),
			recent_provider_usage: recentUsage.map((usage) => ({
				operation_id: usage.operation_id,
				job_id: usage.job_id,
				provider: usage.provider,
				model: usage.model,
				audio_duration_seconds:
					usage.audio_duration_ms === null
						? null
						: usage.audio_duration_ms / 1_000,
				input_tokens: usage.input_tokens,
				output_tokens: usage.output_tokens,
				estimated_cost_usd: microsToMoney(usage.estimated_micros),
				actual_cost_usd: microsToMoney(usage.actual_micros),
				status: usage.status,
				provider_reference: usage.provider_reference,
				attempt_count: usage.attempt_count,
				manually_reconciled: Boolean(usage.manually_reconciled),
				started_at: usage.started_at,
				completed_at: usage.completed_at,
			})),
		});
	}
}

function optionalNonNegativeInteger(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		(Number.isInteger(value) && typeof value === "number" && value >= 0)
	);
}
