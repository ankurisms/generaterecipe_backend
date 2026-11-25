import { describe, expect, it } from "vitest";
import { processRecipe } from "../src/recipeProcessor";
import {
	getBoundedRetryDelayMs,
	getOpenRouterReportedCost,
	requestOpenRouterCompletion,
} from "../src/openRouterClient";
import { validateRecipe } from "../src/recipeValidator";
import { normalizeUserTranscript } from "../src/transcript";
import type { YouTubeMetadata } from "../src/sourceResolver";
import type { UserProvidedTranscript } from "../src/transcript";
import type { YouTubeSource } from "../src/youtubeProvider";

const source: YouTubeSource = {
	platform: "youtube",
	original_url: "https://youtu.be/abcdefghijk",
	normalized_url: "https://www.youtube.com/watch?v=abcdefghijk",
	video_id: "abcdefghijk",
};

const metadata: YouTubeMetadata = {
	status: "available",
	video_title: "A tomato recipe",
	creator: "Example cook",
};

const transcript: UserProvidedTranscript = {
	text: "Corta dos tomates y cocínalos durante diez minutos.",
	language: "es",
	source: "user_provided",
};

function modelRecipe(): Record<string, unknown> {
	return {
		title: {
			value: "Tomato recipe",
			provenance: {
				kind: "explicit",
				evidence: [{ type: "transcript", excerpt: "dos tomates" }],
			},
		},
		description: {
			value: "A simple tomato dish.",
			provenance: { kind: "explicit" },
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
			provenance: {
				kind: "explicit",
				evidence: [{ type: "transcript", excerpt: "diez minutos" }],
			},
		},
		total_time: {
			seconds: null,
			text: null,
			provenance: { kind: "not_specified" },
		},
		equipment: [],
		ingredients: [
			{
				id: "tomato",
				name: "tomatoes",
				quantity: {
					amount: 2,
					amount_text: "dos",
					unit: "tomatoes",
					provenance: {
						kind: "explicit",
						evidence: [{ type: "transcript", excerpt: "dos tomates" }],
					},
				},
				preparation_notes: [],
				provenance: { kind: "explicit" },
			},
		],
		instructions: [
			{
				step: 1,
				phase: "cooking",
				text: "Cook the tomatoes for ten minutes.",
				duration: {
					seconds: 600,
					text: "10 minutes",
					provenance: {
						kind: "explicit",
						evidence: [{ type: "transcript", excerpt: "diez minutos" }],
					},
				},
				ingredient_ids: ["tomato"],
				provenance: { kind: "explicit" },
			},
		],
		warnings: [],
		missing_information: ["servings", "prep_time", "total_time"],
	};
}

function providerResponse(recipe: Record<string, unknown>): Response {
	return new Response(
		JSON.stringify({
			id: "gen-test-usage",
			model: "test/model",
			usage: {
				prompt_tokens: 120,
				completion_tokens: 80,
				cost: 0.0001,
			},
			choices: [
				{
					message: {
						content: JSON.stringify({
							source_language: "es",
							recipe,
						}),
					},
				},
			],
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe("user transcript normalization", () => {
	it("normalizes line endings and outer whitespace only", () => {
		const result = normalizeUserTranscript(
			{ text: " \r\n First  line\r\nSecond\tline \n ", language: " es " },
			100,
		);
		expect(result).toEqual({
			ok: true,
			transcript: {
				text: "First  line\nSecond\tline",
				language: "es",
				source: "user_provided",
			},
		});
	});

	it("measures transcript size in UTF-8 bytes and rejects empty input", () => {
		expect(
			normalizeUserTranscript({ text: "é" }, 1),
		).toEqual({ ok: false, code: "REQUEST_TOO_LARGE" });
		expect(
			normalizeUserTranscript({ text: " \r\n " }, 100),
		).toEqual({ ok: false, code: "INVALID_TRANSCRIPT" });
	});
});

describe("OpenRouter request handling", () => {
	it("requires both secret and configurable model", async () => {
		await expect(
			requestOpenRouterCompletion({}, {}),
		).rejects.toMatchObject({
			code: "AI_PROVIDER_NOT_CONFIGURED",
		});
	});

	it("makes a text request without assuming structured-output support", async () => {
		let sentBody: Record<string, unknown> | undefined;
		const fetcher: typeof fetch = async (_input, init) => {
			sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(JSON.stringify({ choices: [] }), { status: 200 });
		};

		await requestOpenRouterCompletion(
			{ apiKey: "test-key", model: "test/model" },
			{ messages: [{ role: "user", content: "test" }] },
			fetcher,
		);
		expect(sentBody?.model).toBe("test/model");
		expect(sentBody).not.toHaveProperty("response_format");
	});

	it("retries a rejected 429 once but does not retry ambiguous 5xx responses", async () => {
		let retryCalls = 0;
		await requestOpenRouterCompletion(
			{ apiKey: "test-key", model: "test/model" },
			{},
			async () => {
				retryCalls += 1;
				return retryCalls === 1
					? new Response(null, {
							status: 429,
							headers: { "Retry-After": "0" },
						})
					: new Response("{}", { status: 200 });
			},
		);
		expect(retryCalls).toBe(2);

		let noRetryCalls = 0;
		await expect(
			requestOpenRouterCompletion(
				{ apiKey: "test-key", model: "test/model" },
				{},
				async () => {
					noRetryCalls += 1;
					return new Response(null, { status: 503 });
				},
			),
		).rejects.toMatchObject({ code: "AI_PROCESSING_FAILED" });
		expect(noRetryCalls).toBe(1);
	});

	it("accepts only numeric generation costs and fails closed on lookup errors", async () => {
		const reported = await getOpenRouterReportedCost(
			"test-key",
			"gen-test-123",
			async (input) => {
				expect(String(input)).toContain("id=gen-test-123");
				return new Response(JSON.stringify({ data: { total_cost: 0.0012 } }), {
					status: 200,
				});
			},
		);
		expect(reported).toBe(0.0012);

		const malformed = await getOpenRouterReportedCost(
			"test-key",
			"gen-test-malformed",
			async () =>
				new Response(JSON.stringify({ data: { total_cost: "0.0012" } }), {
					status: 200,
				}),
		);
		expect(malformed).toBeNull();

		const unavailable = await getOpenRouterReportedCost(
			"test-key",
			"gen-test-unavailable",
			async () => new Response(null, { status: 503 }),
		);
		expect(unavailable).toBeNull();
	});

	it("bounds Retry-After and does not retry a timed-out request", async () => {
		expect(getBoundedRetryDelayMs("999", 0)).toBe(2_000);
		let calls = 0;
		const fetcher: typeof fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				calls += 1;
				init?.signal?.addEventListener("abort", () => {
					reject(new Error("aborted"));
				});
			});

		await expect(
			requestOpenRouterCompletion(
				{ apiKey: "test-key", model: "test/model" },
				{},
				fetcher,
				5,
			),
		).rejects.toMatchObject({ code: "AI_TIMEOUT" });
		expect(calls).toBe(1);
	});

	it("maps rejected credentials to safe errors", async () => {
		await expect(
			requestOpenRouterCompletion(
				{ apiKey: "secret", model: "test/model" },
				{},
				async () =>
					new Response("provider body containing sensitive details", {
						status: 401,
					}),
			),
		).rejects.toMatchObject({
			code: "AI_PROVIDER_NOT_CONFIGURED",
			message: expect.not.stringContaining("sensitive"),
		});
	});
});

describe("recipe processing and validation", () => {
	it("fails closed before provider calls when model pricing is not matched", async () => {
		let providerCalls = 0;
		await expect(
			processRecipe(
				source,
				metadata,
				transcript,
				{
					OPENROUTER_API_KEY: "test-key",
					OPENROUTER_RECIPE_MODEL: "test/model",
					OPENROUTER_PRICING_MODEL: "different/model",
					OPENROUTER_MAX_INPUT_COST_PER_MILLION_USD: "0.15",
					OPENROUTER_MAX_OUTPUT_COST_PER_MILLION_USD: "0.6",
				},
				async () => {
					providerCalls += 1;
					return providerResponse(modelRecipe());
				},
				25_000,
				{ beforeProviderCall: async () => undefined },
			),
		).rejects.toMatchObject({ code: "AI_COST_ESTIMATE_NOT_CONFIGURED" });
		expect(providerCalls).toBe(0);
	});

	it("reserves against a conservative estimate and reports provider-reported usage", async () => {
		const events: string[] = [];
		let reportedUsage: Record<string, unknown> | undefined;
		const result = await processRecipe(
			source,
			metadata,
			transcript,
			{
				OPENROUTER_API_KEY: "test-key",
				OPENROUTER_RECIPE_MODEL: "test/model",
				OPENROUTER_PRICING_MODEL: "test/model",
				OPENROUTER_MAX_INPUT_COST_PER_MILLION_USD: "0.15",
				OPENROUTER_MAX_OUTPUT_COST_PER_MILLION_USD: "0.6",
			},
			async () => {
				events.push("provider");
				return providerResponse(modelRecipe());
			},
			25_000,
			{
				beforeProviderCall: async (_body, estimatedCost) => {
					expect(estimatedCost).toBeGreaterThan(0.0001);
					events.push("reserved");
				},
				onProviderUsage: async (usage, estimatedCost) => {
					reportedUsage = {
						...usage,
						estimatedCostUsd: estimatedCost,
					};
				},
			},
		);

		expect(events).toEqual(["reserved", "provider"]);
		expect(reportedUsage).toMatchObject({
			model: "test/model",
			inputTokens: 120,
			outputTokens: 80,
			actualCostUsd: 0.0001,
			attemptCount: 1,
		});
		expect(result).toMatchObject({
			processing: {
				usage: {
					provider: "openrouter",
					estimated_cost_usd: expect.any(Number),
					actual_cost_usd: 0.0001,
					status: "reported",
				},
			},
		});
	});

	it("records missing provider usage metadata as pending instead of assuming zero", async () => {
		let reportedUsage: Record<string, unknown> | undefined;
		const result = await processRecipe(
			source,
			metadata,
			transcript,
			{
				OPENROUTER_API_KEY: "test-key",
				OPENROUTER_RECIPE_MODEL: "test/model",
				OPENROUTER_PRICING_MODEL: "test/model",
				OPENROUTER_MAX_INPUT_COST_PER_MILLION_USD: "0.15",
				OPENROUTER_MAX_OUTPUT_COST_PER_MILLION_USD: "0.6",
			},
			async () =>
				new Response(
					JSON.stringify({
						choices: [
							{ message: { content: JSON.stringify({ source_language: "es", recipe: modelRecipe() }) } },
						],
					}),
					{ status: 200 },
				),
			25_000,
			{
				beforeProviderCall: async () => undefined,
				onProviderUsage: async (usage) => {
					reportedUsage = usage;
				},
			},
		);
		expect(reportedUsage).toMatchObject({
			actualCostUsd: null,
			providerReference: null,
		});
		expect(result).toMatchObject({
			processing: {
				usage: { actual_cost_usd: null, status: "usage_pending" },
			},
		});
	});

	it("generates an English recipe and preserves transcript language metadata", async () => {
		const output = await processRecipe(
			source,
			metadata,
			transcript,
			{
				OPENROUTER_API_KEY: "test-key",
				OPENROUTER_RECIPE_MODEL: "test/model",
			},
			async (_input, init) => {
				const requestBody = JSON.parse(String(init?.body)) as Record<
					string,
					unknown
				>;
				expect(requestBody).not.toHaveProperty("response_format");
				return providerResponse(modelRecipe());
			},
		);

		expect(output).toMatchObject({
			api_version: "v1",
			processing: {
				status: "completed",
				transcript_source: "user_provided",
				source_language: "es",
				output_language: "en",
			},
			recipe: {
				title: { value: "Tomato recipe" },
				source: {
					platform: "youtube",
					video_id: "abcdefghijk",
					video_title: { value: "A tomato recipe" },
				},
			},
		});
		expect(JSON.stringify(output)).not.toContain("diez minutos");
	});

	it("rejects malformed or semantically invalid model output", async () => {
		await expect(
			processRecipe(source, metadata, transcript, {
				OPENROUTER_API_KEY: "test-key",
				OPENROUTER_RECIPE_MODEL: "test/model",
			}, async () =>
				new Response(
					JSON.stringify({
						choices: [{ message: { content: "not json" } }],
					}),
					{ status: 200 },
				)),
		).rejects.toMatchObject({ code: "INVALID_RECIPE_OUTPUT" });

		const invalid = modelRecipe();
		(invalid.ingredients as Array<Record<string, unknown>>)[0].quantity = {
			amount: null,
			amount_text: null,
			unit: null,
			provenance: { kind: "estimated" },
		};
		await expect(
			processRecipe(source, metadata, transcript, {
				OPENROUTER_API_KEY: "test-key",
				OPENROUTER_RECIPE_MODEL: "test/model",
			}, async () => providerResponse(invalid)),
		).rejects.toMatchObject({ code: "INVALID_RECIPE_OUTPUT" });

		const missingMarker = modelRecipe();
		missingMarker.missing_information = ["servings", "prep_time"];
		await expect(
			processRecipe(source, metadata, transcript, {
				OPENROUTER_API_KEY: "test-key",
				OPENROUTER_RECIPE_MODEL: "test/model",
			}, async () => providerResponse(missingMarker)),
		).rejects.toMatchObject({ code: "INVALID_RECIPE_OUTPUT" });
	});

	it("rejects broken instruction numbering and ingredient references", () => {
		const recipe = modelRecipe();
		const instruction = (recipe.instructions as Array<Record<string, unknown>>)[0];
		instruction.step = 2;
		instruction.ingredient_ids = ["unknown"];

		const result = validateRecipe({
			...recipe,
			schema_version: "1.0.0",
			id: "test-id",
			source: {
				platform: "youtube",
				original_url: source.original_url,
				video_id: source.video_id,
				video_title: { value: null, provenance: { kind: "not_specified" } },
				creator: { value: null, provenance: { kind: "not_specified" } },
			},
		});
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.errors.map(({ path }) => path)).toContain("/instructions/0/step");
			expect(result.errors.map(({ path }) => path)).toContain(
				"/instructions/0/ingredient_ids/0",
			);
		}
	});
});
