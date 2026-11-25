import { ApiError } from "./apiErrors";
import type { AIUsageLedger } from "./aiUsageLedger";

export const MAX_RECIPE_OUTPUT_TOKENS = 4_096;

export type AiBudgetEnvironment = {
	AI_USAGE_LEDGER?: DurableObjectNamespace<AIUsageLedger>;
	AI_BUDGET_LIMIT_USD?: string;
	AI_BUDGET_RESERVE_USD?: string;
	OPENROUTER_RECIPE_MODEL?: string;
	OPENROUTER_PRICING_MODEL?: string;
	OPENROUTER_MAX_INPUT_COST_PER_MILLION_USD?: string;
	OPENROUTER_MAX_OUTPUT_COST_PER_MILLION_USD?: string;
};

export type OpenRouterUsageRecord = {
	operationId: string;
	model: string;
	inputTokens: number | null;
	outputTokens: number | null;
	actualCostUsd: number | null;
	providerReference: string | null;
	attemptCount: number;
	status?: "started" | "succeeded" | "failed" | "usage_pending";
};

export type ProviderUsageRecord = OpenRouterUsageRecord & {
	provider: "openrouter" | "cloudflare_workers_ai";
	audioDurationMs?: number | null;
};

function parseNonNegativeNumber(value: string | undefined, defaultValue: number): number {
	if (value === undefined || value.trim() === "") return defaultValue;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new ApiError(
			503,
			"AI_BUDGET_NOT_CONFIGURED",
			"AI budget configuration is invalid. Check the Worker environment variables.",
		);
	}
	return parsed;
}

export function getBudgetConfiguration(env: AiBudgetEnvironment): {
	limitUsd: number;
	reserveUsd: number;
} {
	const limitUsd = parseNonNegativeNumber(env.AI_BUDGET_LIMIT_USD, 20);
	const reserveUsd = parseNonNegativeNumber(env.AI_BUDGET_RESERVE_USD, 5);
	if (limitUsd <= 0 || reserveUsd > limitUsd) {
		throw new ApiError(
			503,
			"AI_BUDGET_NOT_CONFIGURED",
			"AI budget configuration is invalid. Check the Worker environment variables.",
		);
	}
	return { limitUsd, reserveUsd };
}

export function estimateRecipeCallCostUsd(
	requestBody: unknown,
	env: AiBudgetEnvironment,
	model: string,
): number {
	if (
		!env.OPENROUTER_PRICING_MODEL?.trim() ||
		env.OPENROUTER_PRICING_MODEL.trim() !== model.trim()
	) {
		throw new ApiError(
			503,
			"AI_COST_ESTIMATE_NOT_CONFIGURED",
			"OpenRouter model pricing is not configured for the selected recipe model.",
		);
	}
	const inputPrice = parseNonNegativeNumber(
		env.OPENROUTER_MAX_INPUT_COST_PER_MILLION_USD,
		Number.NaN,
	);
	const outputPrice = parseNonNegativeNumber(
		env.OPENROUTER_MAX_OUTPUT_COST_PER_MILLION_USD,
		Number.NaN,
	);
	if (!Number.isFinite(inputPrice) || !Number.isFinite(outputPrice)) {
		throw new ApiError(
			503,
			"AI_COST_ESTIMATE_NOT_CONFIGURED",
			"OpenRouter model pricing is not configured. Set maximum input and output token prices for the selected model endpoint.",
		);
	}

	const inputBytes = new TextEncoder().encode(JSON.stringify(requestBody)).byteLength;
	const inputCost = (inputBytes * inputPrice) / 1_000_000;
	const outputCost =
		(MAX_RECIPE_OUTPUT_TOKENS * outputPrice) / 1_000_000;
	// Reserve for both the original request and the one eligible provider retry.
	return Math.max(0.000001, 2 * (inputCost + outputCost));
}

async function hashIdempotencyKey(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`POST /api/v1/recipes/process\0${value}`),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function ledgerStub(env: AiBudgetEnvironment): DurableObjectStub<AIUsageLedger> {
	const namespace = env.AI_USAGE_LEDGER;
	if (!namespace) {
		throw new ApiError(
			503,
			"USAGE_LEDGER_UNAVAILABLE",
			"AI usage tracking is not configured.",
			true,
		);
	}
	return namespace.getByName("application-ai-budget");
}

async function requestLedger(
	env: AiBudgetEnvironment,
	path: string,
	init?: RequestInit,
): Promise<Record<string, unknown>> {
	let response: Response;
	try {
		response = await ledgerStub(env).fetch(`https://ai-usage-ledger/${path}`, init);
	} catch {
		throw new ApiError(
			503,
			"USAGE_LEDGER_UNAVAILABLE",
			"AI usage tracking is temporarily unavailable.",
			true,
		);
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new ApiError(
			503,
			"USAGE_LEDGER_UNAVAILABLE",
			"AI usage tracking returned an invalid response.",
			true,
		);
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new ApiError(
			503,
			"USAGE_LEDGER_UNAVAILABLE",
			"AI usage tracking returned an invalid response.",
			true,
		);
	}
	return { ...body, _httpStatus: response.status };
}

export async function reserveAiJob(
	env: AiBudgetEnvironment,
	idempotencyKey: string,
	estimatedCostUsd: number,
): Promise<{ jobId: string }> {
	if (idempotencyKey.trim().length < 8 || idempotencyKey.length > 200) {
		throw new ApiError(
			400,
			"INVALID_IDEMPOTENCY_KEY",
			"Provide an Idempotency-Key between 8 and 200 characters.",
		);
	}
	const budget = getBudgetConfiguration(env);
	const result = await requestLedger(env, "reserve", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			idempotencyHash: await hashIdempotencyKey(idempotencyKey),
			estimatedCostUsd,
			budgetLimitUsd: budget.limitUsd,
			reserveUsd: budget.reserveUsd,
		}),
	});

	if (result.reason === "budget_exhausted") {
		throw new ApiError(
			402,
			"AI_BUDGET_EXHAUSTED",
			"The application AI spending limit has been reached. Contact an administrator before retrying.",
		);
	}
	if (result.reason === "duplicate") {
		throw new ApiError(
			409,
			"IDEMPOTENCY_KEY_REUSED",
			"This Idempotency-Key has already been used. Use a new key for a new recipe request.",
		);
	}
	if (
		result._httpStatus !== 201 ||
		result.accepted !== true ||
		typeof result.jobId !== "string"
	) {
		throw new ApiError(
			503,
			"USAGE_LEDGER_UNAVAILABLE",
			"AI usage tracking could not reserve budget for this request.",
			true,
		);
	}
	return { jobId: result.jobId };
}

export async function recordOpenRouterUsage(
	env: AiBudgetEnvironment,
	jobId: string,
	usage: OpenRouterUsageRecord,
	estimatedCostUsd: number,
): Promise<void> {
	return recordProviderUsage(
		env,
		jobId,
		{ ...usage, provider: "openrouter" },
		estimatedCostUsd,
	);
}

export async function recordProviderUsage(
	env: AiBudgetEnvironment,
	jobId: string,
	usage: ProviderUsageRecord,
	estimatedCostUsd: number,
): Promise<void> {
	const result = await requestLedger(env, "usage", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jobId,
			...usage,
			estimatedCostUsd,
			status:
				usage.status ??
				(usage.actualCostUsd === null ? "usage_pending" : "succeeded"),
		}),
	});
	if (result._httpStatus !== 200 || result.accepted !== true) {
		throw new ApiError(
			503,
			"USAGE_LEDGER_UNAVAILABLE",
			"AI usage tracking could not record provider usage.",
			true,
		);
	}
}

export async function finishAiJob(
	env: AiBudgetEnvironment,
	jobId: string,
	status: "completed" | "failed",
	holdReservation = false,
): Promise<{
	status: string;
	estimatedCostUsd: number;
	actualCostUsd: number | null;
	reservedCostUsd: number;
}> {
	const result = await requestLedger(env, "finish", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jobId, status, holdReservation }),
	});
	if (
		result._httpStatus !== 200 ||
		result.accepted !== true ||
		typeof result.status !== "string" ||
		typeof result.estimatedCostUsd !== "number" ||
		(result.actualCostUsd !== null &&
			typeof result.actualCostUsd !== "number") ||
		typeof result.reservedCostUsd !== "number"
	) {
		throw new ApiError(
			503,
			"USAGE_LEDGER_UNAVAILABLE",
			"AI usage tracking could not finalize this recipe job.",
			true,
		);
	}
	return {
		status: result.status,
		estimatedCostUsd: result.estimatedCostUsd,
		actualCostUsd: result.actualCostUsd,
		reservedCostUsd: result.reservedCostUsd,
	};
}

export async function getAiUsageSummary(
	env: AiBudgetEnvironment,
): Promise<unknown> {
	const budget = getBudgetConfiguration(env);
	const result = await requestLedger(
		env,
		`summary?limit=50&budgetLimitUsd=${encodeURIComponent(String(budget.limitUsd))}&reserveUsd=${encodeURIComponent(String(budget.reserveUsd))}`,
	);
	if (result._httpStatus !== 200) {
		throw new ApiError(
			503,
			"USAGE_LEDGER_UNAVAILABLE",
			"AI usage tracking could not load its summary.",
			true,
		);
	}
	const { _httpStatus: _ignored, ...summary } = result;
	return summary;
}

export async function reconcileAiUsage(
	env: AiBudgetEnvironment,
	operationId: string,
	actualCostUsd: number,
	status: "succeeded" | "failed",
): Promise<{
	status: string;
	actualCostUsd: number;
	jobActualCostUsd: number;
	reservedCostUsd: number;
}> {
	const result = await requestLedger(env, "reconcile", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			operationId,
			actualCostUsd,
			status,
		}),
	});
	if (result._httpStatus === 404) {
		throw new ApiError(
			404,
			"AI_USAGE_RECONCILIATION_FAILED",
			"The pending provider operation was not found.",
		);
	}
	if (result._httpStatus === 409) {
		throw new ApiError(
			409,
			"AI_USAGE_RECONCILIATION_CONFLICT",
			"The provider operation is already settled or its job is not pending.",
		);
	}
	if (result._httpStatus === 400) {
		throw new ApiError(
			400,
			"INVALID_REQUEST",
			"The reconciliation values were rejected by the usage ledger.",
		);
	}
	if (
		result._httpStatus !== 200 ||
		result.accepted !== true ||
		typeof result.status !== "string" ||
		typeof result.actualCostUsd !== "number" ||
		typeof result.jobActualCostUsd !== "number" ||
		typeof result.reservedCostUsd !== "number"
	) {
		throw new ApiError(
			503,
			"USAGE_LEDGER_UNAVAILABLE",
			"AI usage tracking could not reconcile provider usage.",
			true,
		);
	}
	return {
		status: result.status,
		actualCostUsd: result.actualCostUsd,
		jobActualCostUsd: result.jobActualCostUsd,
		reservedCostUsd: result.reservedCostUsd,
	};
}
