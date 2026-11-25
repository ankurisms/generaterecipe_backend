import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function ledger() {
	return env.AI_USAGE_LEDGER.getByName(`test-ledger-${crypto.randomUUID()}`);
}

async function post(stub: ReturnType<typeof ledger>, path: string, body: unknown) {
	return stub.fetch(`https://ledger/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function reserveBody(idempotencyHash: string, estimatedCostUsd: number) {
	return {
		idempotencyHash,
		estimatedCostUsd,
		budgetLimitUsd: 0.01,
		reserveUsd: 0,
	};
}

describe("AI usage Durable Object ledger", () => {
	it("atomically blocks concurrent reservations beyond the configured cap", async () => {
		const stub = ledger();
		const [first, second] = await Promise.all([
			post(stub, "reserve", reserveBody("a".repeat(64), 0.006)),
			post(stub, "reserve", reserveBody("b".repeat(64), 0.006)),
		]);

		expect([first.status, second.status].sort()).toEqual([201, 429]);
	});

	it("allows only one concurrent reservation for the same scoped key", async () => {
		const stub = ledger();
		const body = reserveBody("8".repeat(64), 0.004);
		const [first, second] = await Promise.all([
			post(stub, "reserve", body),
			post(stub, "reserve", body),
		]);

		expect([first.status, second.status].sort()).toEqual([201, 409]);
		const summary = await stub.fetch(
			"https://ledger/summary?limit=10&budgetLimitUsd=0.01&reserveUsd=0",
		);
		expect(await summary.json()).toMatchObject({
			budget: { reserved_spend_usd: 0.004 },
			totals: { jobs: 1 },
		});
	});

	it("deduplicates idempotency keys without increasing reserved spend", async () => {
		const stub = ledger();
		const body = reserveBody("c".repeat(64), 0.004);
		const first = await post(stub, "reserve", body);
		const firstBody = await first.json();
		const duplicate = await post(stub, "reserve", body);

		expect(first.status).toBe(201);
		expect(duplicate.status).toBe(409);
		expect(await duplicate.json()).toMatchObject({
			accepted: false,
			reason: "duplicate",
			jobId: firstBody.jobId,
		});
	});

	it("does not let a repeated started event erase known provider charges", async () => {
		const stub = ledger();
		const reserved = await post(
			stub,
			"reserve",
			reserveBody("6".repeat(64), 0.008),
		);
		const { jobId } = (await reserved.json()) as { jobId: string };
		const operationId = crypto.randomUUID();
		const usage = {
			jobId,
			operationId,
			provider: "openrouter",
			model: "test/model",
			estimatedCostUsd: 0.008,
			actualCostUsd: 0.003,
			status: "succeeded",
			providerReference: "gen-monotonic",
		};
		await post(stub, "usage", usage);
		await post(stub, "usage", {
			...usage,
			actualCostUsd: null,
			status: "started",
			providerReference: null,
		});
		await post(stub, "finish", { jobId, status: "completed" });

		const summaryResponse = await stub.fetch(
			"https://ledger/summary?limit=10&budgetLimitUsd=0.01&reserveUsd=0",
		);
		expect(await summaryResponse.json()).toMatchObject({
			budget: { actual_spend_usd: 0.003, reserved_spend_usd: 0 },
			recent_provider_usage: [
				{
					actual_cost_usd: 0.003,
					status: "succeeded",
					provider_reference: "gen-monotonic",
				},
			],
		});
	});

	it("reconciles pending provider usage once and reports provider-separated totals", async () => {
		const stub = ledger();
		const reserved = await post(
			stub,
			"reserve",
			reserveBody("d".repeat(64), 0.008),
		);
		const { jobId } = (await reserved.json()) as { jobId: string };
		const operationId = crypto.randomUUID();
		const pending = {
			jobId,
			operationId,
			provider: "openrouter",
			model: "test/model",
			inputTokens: 120,
			outputTokens: 80,
			estimatedCostUsd: 0.008,
			actualCostUsd: null,
			status: "usage_pending",
			providerReference: "gen-test-123",
			attemptCount: 2,
		};
		expect((await post(stub, "usage", pending)).status).toBe(200);
		expect(
			(await post(stub, "finish", { jobId, status: "completed" })).status,
		).toBe(200);

		const reservedWhilePending = await stub.fetch(
			"https://ledger/summary?limit=10&budgetLimitUsd=0.01&reserveUsd=0",
		);
		expect(await reservedWhilePending.json()).toMatchObject({
			budget: { reserved_spend_usd: 0.008 },
			recent_jobs: [{ status: "usage_pending" }],
		});

		expect(
			(
				await post(stub, "reconcile", {
					operationId,
					actualCostUsd: 0.003,
					status: "succeeded",
				})
			).status,
		).toBe(200);
		expect(
			(
				await post(stub, "reconcile", {
					operationId,
					actualCostUsd: 0.003,
					status: "succeeded",
				})
			).status,
		).toBe(409);

		const summaryResponse = await stub.fetch(
			"https://ledger/summary?limit=10&budgetLimitUsd=0.01&reserveUsd=0",
		);
		const summary = await summaryResponse.json();
		expect(summary).toMatchObject({
			budget: { actual_spend_usd: 0.003, reserved_spend_usd: 0 },
			providers: [
				{
					provider: "openrouter",
					input_tokens: 120,
					output_tokens: 80,
					estimated_cost_usd: 0.008,
					actual_cost_usd: 0.003,
				},
			],
			recent_provider_usage: [
				{ provider_reference: "gen-test-123", attempt_count: 2 },
			],
		});
		expect(JSON.stringify(summary)).not.toContain("transcript");
	});

	it("releases unused reservations when a provider job fails before reporting usage", async () => {
		const stub = ledger();
		const reserved = await post(
			stub,
			"reserve",
			reserveBody("e".repeat(64), 0.009),
		);
		const { jobId } = (await reserved.json()) as { jobId: string };
		await post(stub, "finish", { jobId, status: "failed" });

		const next = await post(
			stub,
			"reserve",
			reserveBody("f".repeat(64), 0.009),
		);
		expect(next.status).toBe(201);
	});

	it("keeps unspent reservations for later provider stages in a partial job", async () => {
		const stub = ledger();
		const reserved = await post(
			stub,
			"reserve",
			reserveBody("7".repeat(64), 0.01),
		);
		const { jobId } = (await reserved.json()) as { jobId: string };
		await post(stub, "usage", {
			jobId,
			operationId: crypto.randomUUID(),
			provider: "cloudflare_workers_ai",
			model: "@cf/openai/whisper-large-v3-turbo",
			audioDurationMs: 60_000,
			estimatedCostUsd: 0.004,
			actualCostUsd: 0.003,
			status: "succeeded",
		});
		const secondProviderOperationId = crypto.randomUUID();
		await post(stub, "usage", {
			jobId,
			operationId: secondProviderOperationId,
			provider: "openrouter",
			model: "test/model",
			estimatedCostUsd: 0.006,
			actualCostUsd: null,
			status: "started",
		});
		await post(stub, "finish", { jobId, status: "completed" });

		const pending = await stub.fetch(
			"https://ledger/summary?limit=10&budgetLimitUsd=0.01&reserveUsd=0",
		);
		const pendingSummary = await pending.json();
		expect(pendingSummary, JSON.stringify(pendingSummary)).toMatchObject({
			budget: { actual_spend_usd: 0.003, reserved_spend_usd: 0.006 },
			recent_jobs: [{ actual_cost_usd: 0.003, status: "usage_pending" }],
		});

		await post(stub, "reconcile", {
			operationId: secondProviderOperationId,
			actualCostUsd: 0.002,
			status: "succeeded",
		});
		const complete = await stub.fetch(
			"https://ledger/summary?limit=10&budgetLimitUsd=0.01&reserveUsd=0",
		);
		expect(await complete.json()).toMatchObject({
			budget: { actual_spend_usd: 0.005, reserved_spend_usd: 0 },
			recent_jobs: [{ status: "completed", actual_cost_usd: 0.005 }],
		});
	});

	it("expires only unstarted reservations and rejects late provider starts", async () => {
		const stub = ledger();
		const reserved = await post(
			stub,
			"reserve",
			reserveBody("9".repeat(64), 0.009),
		);
		const { jobId } = (await reserved.json()) as { jobId: string };
		await post(stub, "sweep", {
			now: new Date(Date.now() + 6 * 60 * 1_000).toISOString(),
		});

		const summary = await stub.fetch(
			"https://ledger/summary?limit=10&budgetLimitUsd=0.01&reserveUsd=0",
		);
		expect(await summary.json()).toMatchObject({
			budget: { reserved_spend_usd: 0 },
			recent_jobs: [{ job_id: jobId, status: "failed" }],
		});
		const lateStart = await post(stub, "usage", {
			jobId,
			operationId: crypto.randomUUID(),
			provider: "openrouter",
			model: "test/model",
			estimatedCostUsd: 0.009,
			actualCostUsd: null,
			status: "started",
		});
		expect(lateStart.status).toBe(404);

		const active = await post(
			stub,
			"reserve",
			reserveBody("0".repeat(64), 0.009),
		);
		const activeJob = (await active.json()) as { jobId: string };
		await post(stub, "usage", {
			jobId: activeJob.jobId,
			operationId: crypto.randomUUID(),
			provider: "openrouter",
			model: "test/model",
			estimatedCostUsd: 0.009,
			actualCostUsd: null,
			status: "started",
		});
		await post(stub, "sweep", {
			now: new Date(Date.now() + 6 * 60 * 1_000).toISOString(),
		});
		const activeSummary = await stub.fetch(
			"https://ledger/summary?limit=10&budgetLimitUsd=0.01&reserveUsd=0",
		);
		const activeSummaryBody = (await activeSummary.json()) as {
			budget: { reserved_spend_usd: number };
			recent_jobs: Array<Record<string, unknown>>;
		};
		expect(activeSummaryBody.budget.reserved_spend_usd).toBe(0.009);
		expect(activeSummaryBody.recent_jobs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					job_id: activeJob.jobId,
					status: "processing",
				}),
			]),
		);
	});

	it("does not reserve the protected demo balance", async () => {
		const stub = ledger();
		const nearCap = await post(stub, "reserve", {
			idempotencyHash: "a".repeat(64),
			estimatedCostUsd: 15,
			budgetLimitUsd: 20,
			reserveUsd: 5,
		});
		const beyondCap = await post(stub, "reserve", {
			idempotencyHash: "b".repeat(64),
			estimatedCostUsd: 0.000001,
			budgetLimitUsd: 20,
			reserveUsd: 5,
		});
		expect(nearCap.status).toBe(201);
		expect(beyondCap.status).toBe(429);
	});

	it("tracks Cloudflare STT duration separately from LLM usage", async () => {
		const stub = ledger();
		const reserved = await post(
			stub,
			"reserve",
			reserveBody("1".repeat(64), 0.009),
		);
		const { jobId } = (await reserved.json()) as { jobId: string };
		await post(stub, "usage", {
			jobId,
			operationId: crypto.randomUUID(),
			provider: "cloudflare_workers_ai",
			model: "@cf/openai/whisper-large-v3-turbo",
			audioDurationMs: 65_000,
			inputTokens: null,
			outputTokens: null,
			estimatedCostUsd: 0.000513 * (65 / 60),
			actualCostUsd: 0,
			status: "succeeded",
		});
		await post(stub, "finish", { jobId, status: "completed" });

		const summaryResponse = await stub.fetch(
			"https://ledger/summary?limit=10&budgetLimitUsd=0.01&reserveUsd=0",
		);
		expect(await summaryResponse.json()).toMatchObject({
			providers: [
				{
					provider: "cloudflare_workers_ai",
					audio_duration_seconds: 65,
					actual_cost_usd: 0,
				},
			],
		});
	});
});
