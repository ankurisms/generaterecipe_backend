import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import worker from "../src/index";
import { handleApiRequest } from "../src/api";
import { validateRecipe } from "../src/recipeValidator";
import { identifyYouTubeUrl } from "../src/youtubeProvider";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function callWorker(url: string, init?: RequestInit): Promise<Response> {
	const request = new IncomingRequest(url, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function jsonPost(url: string, body: unknown, headers?: HeadersInit): RequestInit {
	return {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...Object.fromEntries(new Headers(headers)),
		},
		body: JSON.stringify(body),
	};
}

describe("Worker entry point", () => {
	it("preserves the existing Hello World response at the root", async () => {
		const response = await callWorker("http://example.com/");
		expect(await response.text()).toBe("Hello World!");
	});

	it("preserves the existing integration response outside the API namespace", async () => {
		const response = await SELF.fetch("https://example.com/anything");
		expect(await response.text()).toBe("Hello World!");
	});
});

describe("YouTube URL identification", () => {
	it.each([
		"https://www.youtube.com/watch?v=abcdefghijk",
		"https://youtu.be/abcdefghijk",
		"https://m.youtube.com/watch?v=abcdefghijk&t=20",
		"https://www.youtube.com/shorts/abcdefghijk",
		"https://www.youtube.com/embed/abcdefghijk",
		"https://www.youtube.com/live/abcdefghijk",
		"https://www.youtube-nocookie.com/embed/abcdefghijk",
	])("accepts supported URL format %s", (url) => {
		const result = identifyYouTubeUrl(url);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.source.video_id).toBe("abcdefghijk");
			expect(result.source.normalized_url).toBe(
				"https://www.youtube.com/watch?v=abcdefghijk",
			);
			expect(result.source.original_url).toBe(url);
		}
	});

	it.each([
		["not a URL", "INVALID_URL"],
		["https://www.youtube.com/watch", "INVALID_YOUTUBE_URL"],
		["https://www.youtube.com/watch?v=abc", "INVALID_YOUTUBE_URL"],
		[
			"https://www.youtube.com/watch?v=abcdefghijk&v=lmnopqrstuv",
			"INVALID_YOUTUBE_URL",
		],
		["https://www.instagram.com/reel/abc123/", "UNSUPPORTED_SOURCE"],
		["https://example.com/video/abcdefghijk", "UNSUPPORTED_SOURCE"],
		["http://www.youtube.com/watch?v=abcdefghijk", "INVALID_URL"],
		["https://youtube.com.evil.example/watch?v=abcdefghijk", "UNSUPPORTED_SOURCE"],
	])("rejects %s with %s", (url, code) => {
		const result = identifyYouTubeUrl(url);
		expect(result).toEqual({ ok: false, code });
	});
});

describe("versioned API", () => {
	it("returns a JSON health response", async () => {
		const response = await callWorker("https://api.example/api/v1/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: "ok",
			api_version: "v1",
		});
	});

	it("identifies a valid YouTube URL without claiming metadata or extraction", async () => {
		const response = await callWorker(
			"https://api.example/api/v1/recipes/preview",
			jsonPost("https://api.example/api/v1/recipes/preview", {
				url: "https://youtu.be/abcdefghijk",
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			api_version: "v1",
			source: {
				platform: "youtube",
				video_id: "abcdefghijk",
				original_url: "https://youtu.be/abcdefghijk",
			},
			metadata: { status: "not_configured" },
			extraction: { status: "not_configured" },
		});
	});

	it("returns a clear error for unsupported platforms", async () => {
		const response = await callWorker(
			"https://api.example/api/v1/recipes/preview",
			jsonPost("https://api.example/api/v1/recipes/preview", {
				url: "https://www.instagram.com/reel/abc123/",
			}),
		);
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			error: { code: "UNSUPPORTED_SOURCE" },
		});
	});

	it("reports extraction as unavailable without pretending to generate a recipe", async () => {
		const response = await callWorker(
			"https://api.example/api/v1/recipes/process",
			jsonPost("https://api.example/api/v1/recipes/process", {
				url: "https://youtu.be/abcdefghijk",
			}),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { code: "EXTRACTION_NOT_CONFIGURED", retryable: false },
		});
	});

	it("accepts process payloads larger than the preview limit", async () => {
		const response = await handleApiRequest(
			new IncomingRequest("https://api.example/api/v1/recipes/process", {
				...jsonPost("https://api.example/api/v1/recipes/process", {
					url: "https://youtu.be/abcdefghijk",
					fallback_transcript: { text: "recipe transcript ".repeat(600) },
				}),
			}),
			{
				...env,
				YOUTUBE_API_KEY: undefined,
				OPENROUTER_API_KEY: undefined,
				OPENROUTER_RECIPE_MODEL: undefined,
			},
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { code: "AI_PROVIDER_NOT_CONFIGURED" },
		});
	});

	it("routes a supplied transcript to the mocked recipe provider without exposing it", async () => {
		const marker = "private transcript marker";
		const providerFetch = vi.fn(async () =>
			new Response(
				JSON.stringify({
					id: "gen-index-usage",
					model: "test/model",
					usage: {
						prompt_tokens: 120,
						completion_tokens: 80,
						cost: 0.0002,
					},
					choices: [{ message: { content: "not valid recipe JSON" } }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", providerFetch);

		try {
			const response = await handleApiRequest(
				new IncomingRequest("https://api.example/api/v1/recipes/process", {
					...jsonPost("https://api.example/api/v1/recipes/process", {
						url: "https://youtu.be/abcdefghijk",
						fallback_transcript: { text: marker, language: "en" },
					}, { "Idempotency-Key": "private-transcript-test-job" }),
				}),
				{
					...env,
					YOUTUBE_API_KEY: undefined,
					OPENROUTER_API_KEY: "test-secret",
					OPENROUTER_RECIPE_MODEL: "test/model",
					OPENROUTER_PRICING_MODEL: "test/model",
					OPENROUTER_MAX_INPUT_COST_PER_MILLION_USD: "0.15",
					OPENROUTER_MAX_OUTPUT_COST_PER_MILLION_USD: "0.6",
				},
			);

			expect(response.status, await response.clone().text()).toBe(502);
			const errorBody = await response.json();
			expect(errorBody).toMatchObject({
				error: {
					code: "INVALID_RECIPE_OUTPUT",
					job_id: expect.any(String),
					usage_operation_id: expect.any(String),
				},
			});
			expect(JSON.stringify(errorBody)).not.toContain(marker);
			expect(providerFetch).toHaveBeenCalledTimes(1);
			expect(response.headers.get("X-Request-Id")).toBeTruthy();

			const duplicate = await handleApiRequest(
				new IncomingRequest("https://api.example/api/v1/recipes/process", {
					...jsonPost("https://api.example/api/v1/recipes/process", {
						url: "https://youtu.be/abcdefghijk",
						fallback_transcript: { text: marker, language: "en" },
					}, { "Idempotency-Key": "private-transcript-test-job" }),
				}),
				{
					...env,
					YOUTUBE_API_KEY: undefined,
					OPENROUTER_API_KEY: "test-secret",
					OPENROUTER_RECIPE_MODEL: "test/model",
					OPENROUTER_PRICING_MODEL: "test/model",
					OPENROUTER_MAX_INPUT_COST_PER_MILLION_USD: "0.15",
					OPENROUTER_MAX_OUTPUT_COST_PER_MILLION_USD: "0.6",
				},
			);
			expect(duplicate.status).toBe(409);
			expect(await duplicate.json()).toMatchObject({
				error: { code: "IDEMPOTENCY_KEY_REUSED" },
			});
			expect(providerFetch).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("reserves AI budget before calling the provider and rejects over-budget jobs", async () => {
		const providerFetch = vi.fn(async () => new Response("unexpected", { status: 500 }));
		vi.stubGlobal("fetch", providerFetch);
		try {
			const response = await handleApiRequest(
				new IncomingRequest("https://api.example/api/v1/recipes/process", {
					...jsonPost(
						"https://api.example/api/v1/recipes/process",
						{
							url: "https://youtu.be/abcdefghijk",
							fallback_transcript: { text: "Mix the ingredients." },
						},
						{ "Idempotency-Key": "budget-exhausted-test" },
					),
				}),
				{
					...env,
					OPENROUTER_API_KEY: "test-secret",
					OPENROUTER_RECIPE_MODEL: "test/model",
					OPENROUTER_PRICING_MODEL: "test/model",
					OPENROUTER_MAX_INPUT_COST_PER_MILLION_USD: "0.15",
					OPENROUTER_MAX_OUTPUT_COST_PER_MILLION_USD: "0.6",
					AI_BUDGET_LIMIT_USD: "0.000001",
					AI_BUDGET_RESERVE_USD: "0",
				},
			);
			expect(response.status).toBe(402);
			expect(await response.json()).toMatchObject({
				error: { code: "AI_BUDGET_EXHAUSTED" },
			});
			expect(providerFetch).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("protects the usage summary with the configured admin token", async () => {
		const unauthorized = await handleApiRequest(
			new IncomingRequest("https://api.example/api/v1/admin/usage"),
			{ ...env, AI_USAGE_ADMIN_TOKEN: "test-admin" },
		);
		expect(unauthorized.status).toBe(401);
		expect(await unauthorized.json()).toMatchObject({
			error: { code: "AI_USAGE_ADMIN_UNAUTHORIZED" },
		});

		const authorized = await handleApiRequest(
			new IncomingRequest("https://api.example/api/v1/admin/usage", {
				headers: { Authorization: "Bearer test-admin" },
			}),
			{ ...env, AI_USAGE_ADMIN_TOKEN: "test-admin" },
		);
		expect(authorized.status).toBe(200);
		const payload = await authorized.json();
		expect(payload).toMatchObject({
			api_version: "v1",
			usage: {
				budget: {
					limit_usd: 20,
					reserved_for_demo_usd: 5,
				},
				providers: expect.any(Array),
				recent_provider_usage: expect.any(Array),
			},
		});
		expect(JSON.stringify(payload)).not.toContain("private transcript marker");

		const unauthorizedPost = await handleApiRequest(
			new IncomingRequest("https://api.example/api/v1/admin/usage", {
				...jsonPost("https://api.example/api/v1/admin/usage", {
					operation_id: crypto.randomUUID(),
					actual_cost_usd: 0,
					provider_status: "failed",
				}),
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer wrong-token",
				},
			}),
			{ ...env, AI_USAGE_ADMIN_TOKEN: "test-admin" },
		);
		expect(unauthorizedPost.status).toBe(401);
	});

	it("allows an authenticated admin to reconcile pending usage exactly once", async () => {
		const ledger = env.AI_USAGE_LEDGER.getByName("application-ai-budget");
		const key = `admin-reconcile-${crypto.randomUUID()}`;
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(`POST /api/v1/recipes/process\0${key}`),
		);
		const idempotencyHash = Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		const reserved = await ledger.fetch("https://ledger/reserve", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				idempotencyHash,
				estimatedCostUsd: 0.01,
				budgetLimitUsd: 20,
				reserveUsd: 5,
			}),
		});
		const { jobId } = (await reserved.json()) as { jobId: string };
		const operationId = crypto.randomUUID();
		await ledger.fetch("https://ledger/usage", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jobId,
				operationId,
				provider: "openrouter",
				model: "test/model",
				estimatedCostUsd: 0.01,
				actualCostUsd: null,
				status: "started",
				providerReference: "gen-admin-reconcile",
			}),
		});
		await ledger.fetch("https://ledger/finish", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jobId,
				status: "failed",
				holdReservation: true,
			}),
		});

		const request = () =>
			handleApiRequest(
				new IncomingRequest("https://api.example/api/v1/admin/usage", {
					...jsonPost("https://api.example/api/v1/admin/usage", {
						operation_id: operationId,
						actual_cost_usd: 0.001,
						provider_status: "succeeded",
					}),
					headers: {
						"Content-Type": "application/json",
						Authorization: "Bearer test-admin",
					},
				}),
				{ ...env, AI_USAGE_ADMIN_TOKEN: "test-admin" },
			);
		const reconciled = await request();
		expect(reconciled.status).toBe(200);
		expect(await reconciled.json()).toMatchObject({
			reconciliation: {
				status: "failed",
				actualCostUsd: 0.001,
				jobActualCostUsd: 0.001,
				reservedCostUsd: 0,
			},
		});
		expect((await request()).status).toBe(409);

		const summary = await handleApiRequest(
			new IncomingRequest("https://api.example/api/v1/admin/usage", {
				headers: { Authorization: "Bearer test-admin" },
			}),
			{ ...env, AI_USAGE_ADMIN_TOKEN: "test-admin" },
		);
		const summaryBody = (await summary.json()) as {
			usage: { recent_provider_usage: Array<Record<string, unknown>> };
		};
		expect(summaryBody.usage.recent_provider_usage).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					operation_id: operationId,
					manually_reconciled: true,
				}),
			]),
		);
	});

	it("keeps process requests without an idempotency key backward-compatible", async () => {
		const providerFetch = vi.fn(async () =>
			new Response(
				JSON.stringify({
					usage: { cost: 0.0002 },
					choices: [{ message: { content: "invalid recipe JSON" } }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", providerFetch);
		try {
			for (let attempt = 0; attempt < 2; attempt += 1) {
				const response = await handleApiRequest(
					new IncomingRequest("https://api.example/api/v1/recipes/process", {
						...jsonPost("https://api.example/api/v1/recipes/process", {
							url: "https://youtu.be/abcdefghijk",
							fallback_transcript: { text: "Mix ingredients." },
						}),
					}),
					{
						...env,
						OPENROUTER_API_KEY: "test-secret",
						OPENROUTER_RECIPE_MODEL: "test/model",
						OPENROUTER_PRICING_MODEL: "test/model",
						OPENROUTER_MAX_INPUT_COST_PER_MILLION_USD: "0.15",
						OPENROUTER_MAX_OUTPUT_COST_PER_MILLION_USD: "0.6",
					},
				);
				expect(response.status).toBe(502);
			}
			expect(providerFetch).toHaveBeenCalledTimes(2);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("rate-limits recipe processing by client IP", async () => {
		const responses: Response[] = [];
		for (let attempt = 0; attempt < 11; attempt += 1) {
			responses.push(
				await callWorker("https://api.example/api/v1/recipes/process", {
					...jsonPost("https://api.example/api/v1/recipes/process", {
						url: "https://youtu.be/abcdefghijk",
					}),
					headers: {
						"Content-Type": "application/json",
						"CF-Connecting-IP": "203.0.113.19",
					},
				}),
			);
		}

		expect(responses.slice(0, 10).every((response) => response.status === 503)).toBe(
			true,
		);
		expect(responses[10].status).toBe(429);
		expect(responses[10].headers.get("Retry-After")).toBe("60");
		expect(await responses[10].json()).toMatchObject({
			error: { code: "RATE_LIMITED", retryable: true },
		});
	});

	it("rejects malformed, missing, and oversized JSON input", async () => {
		const invalidJson = await callWorker(
			"https://api.example/api/v1/recipes/preview",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{",
			},
		);
		expect(invalidJson.status).toBe(400);
		expect(await invalidJson.json()).toMatchObject({
			error: { code: "INVALID_JSON" },
		});

		const missingUrl = await callWorker(
			"https://api.example/api/v1/recipes/preview",
			jsonPost("https://api.example/api/v1/recipes/preview", {}),
		);
		expect(missingUrl.status).toBe(400);
		expect(await missingUrl.json()).toMatchObject({
			error: { code: "MISSING_URL" },
		});

		const oversized = await callWorker(
			"https://api.example/api/v1/recipes/preview",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url: "x".repeat(9000) }),
			},
		);
		expect(oversized.status).toBe(413);
		expect(await oversized.json()).toMatchObject({
			error: { code: "REQUEST_TOO_LARGE" },
		});
	});

	it("enforces the process payload limit using actual UTF-8 bytes", async () => {
		const body = JSON.stringify({
			url: "https://youtu.be/abcdefghijk",
			fallback_transcript: { text: "é".repeat(131_072) },
		});
		expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(256 * 1024);
		const response = await callWorker(
			"https://api.example/api/v1/recipes/process",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			},
		);

		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({
			error: { code: "REQUEST_TOO_LARGE" },
		});
	});

	it("applies CORS only to the approved frontend origins", async () => {
		const allowed = await callWorker(
			"https://api.example/api/v1/health",
			{ headers: { Origin: "https://generaterecipe.lovable.app" } },
		);
		expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
			"https://generaterecipe.lovable.app",
		);

		const denied = await callWorker("https://api.example/api/v1/health", {
			headers: { Origin: "https://ankurbhatia-product.lovable.app" },
		});
		expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});

	it("accepts preflight only for approved origins and headers", async () => {
		const allowed = await callWorker("https://api.example/api/v1/recipes/process", {
			method: "OPTIONS",
			headers: {
				Origin: "http://localhost:5173",
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "content-type",
			},
		});
		expect(allowed.status).toBe(204);
		expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
			"http://localhost:5173",
		);
		expect(allowed.headers.get("Vary")).toBe("Origin");

		const denied = await callWorker("https://api.example/api/v1/recipes/process", {
			method: "OPTIONS",
			headers: {
				Origin: "https://ankurbhatia-product.lovable.app",
				"Access-Control-Request-Method": "POST",
			},
		});
		expect(denied.status).toBe(403);
	});
});

describe("recipe contract validation", () => {
	it("accepts a recipe with explicit missing-information markers", () => {
		const recipe = {
			schema_version: "1.0.0",
			id: "ephemeral-id",
			title: {
				value: "Tomato pasta",
				provenance: { kind: "explicit" },
			},
			description: {
				value: "A simple tomato pasta.",
				provenance: { kind: "explicit" },
			},
			source: {
				platform: "youtube",
				original_url: "https://www.youtube.com/watch?v=abcdefghijk",
				video_id: "abcdefghijk",
				video_title: {
					value: null,
					provenance: { kind: "not_specified" },
				},
				creator: {
					value: null,
					provenance: { kind: "not_specified" },
				},
			},
			servings: {
				value: null,
				provenance: { kind: "not_specified" },
			},
			prep_time: {
				seconds: null,
				text: null,
				provenance: { kind: "not_specified" },
			},
			cook_time: {
				seconds: 600,
				text: "10 minutes",
				provenance: { kind: "explicit" },
			},
			total_time: {
				seconds: 600,
				text: "10 minutes",
				provenance: { kind: "explicit" },
			},
			equipment: [],
			ingredients: [
				{
					id: "ingredient-1",
					name: "Tomato",
					quantity: {
						amount: null,
						amount_text: null,
						unit: null,
						provenance: { kind: "not_specified" },
					},
					preparation_notes: [],
					provenance: { kind: "explicit" },
				},
			],
			instructions: [
				{
					step: 1,
					phase: "cooking",
					text: "Cook the tomato.",
					duration: {
						seconds: null,
						text: null,
						provenance: { kind: "not_specified" },
					},
					ingredient_ids: ["ingredient-1"],
					provenance: { kind: "explicit" },
				},
			],
			warnings: [],
			missing_information: [
				"source.video_title",
				"source.creator",
				"servings",
				"prep_time",
				"ingredients[0].quantity",
				"instructions[0].duration",
			],
		};

		expect(validateRecipe(recipe)).toEqual({ valid: true });
	});

	it("rejects missing values not marked as not specified", () => {
		const invalidRecipe = {
			schema_version: "1.0.0",
			id: "ephemeral-id",
			title: {
				value: null,
				provenance: { kind: "explicit" },
			},
		};
		const result = validateRecipe(invalidRecipe);
		expect(result.valid).toBe(false);
	});
});
