import { identifyYouTubeUrl } from "./youtubeProvider";
import { resolveYouTubeMetadata } from "./sourceResolver";
import { ApiError } from "./apiErrors";
import {
	normalizeUserTranscript,
	type UserProvidedTranscript,
} from "./transcript";
import { processRecipe } from "./recipeProcessor";
import {
	finishAiJob,
	getAiUsageSummary,
	reconcileAiUsage,
	recordOpenRouterUsage,
	reserveAiJob,
	type AiBudgetEnvironment,
} from "./aiUsage";

const API_PREFIX = "/api/v1";
const MAX_PREVIEW_BODY_BYTES = 8192;
const MAX_PROCESS_BODY_BYTES = 256 * 1024;
const ALLOWED_ORIGINS = new Set([
	"https://generaterecipe.lovable.app",
	"http://localhost:5173",
]);

type WorkerEnvironment = Env & AiBudgetEnvironment & {
	YOUTUBE_API_KEY?: string;
	OPENROUTER_API_KEY?: string;
	OPENROUTER_RECIPE_MODEL?: string;
	AI_USAGE_ADMIN_TOKEN?: string;
	PROCESS_RATE_LIMITER: RateLimit;
	PREVIEW_RATE_LIMITER: RateLimit;
};

function jsonResponse(
	body: unknown,
	status: number,
	requestId: string,
	headers?: HeadersInit,
): Response {
	const responseHeaders = new Headers(headers);
	responseHeaders.set("Content-Type", "application/json; charset=utf-8");
	responseHeaders.set("Cache-Control", "no-store");
	responseHeaders.set("X-Content-Type-Options", "nosniff");
	responseHeaders.set("X-Request-Id", requestId);
	if (status === 429) {
		responseHeaders.set("Retry-After", "60");
	}
	return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function errorResponse(error: ApiError, requestId: string): Response {
	const headers =
		error.retryAfterSeconds === undefined
			? undefined
			: { "Retry-After": String(error.retryAfterSeconds) };
	return jsonResponse(
		{
			error: {
				code: error.code,
				message: error.message,
				retryable: error.retryable,
				...(error.jobId ? { job_id: error.jobId } : {}),
				...(error.usageOperationId
					? { usage_operation_id: error.usageOperationId }
					: {}),
				request_id: requestId,
			},
		},
		error.status,
		requestId,
		headers,
	);
}

function applyCors(response: Response, origin: string | null): Response {
	if (!origin || !ALLOWED_ORIGINS.has(origin)) {
		return response;
	}

	const headers = new Headers(response.headers);
	headers.set("Access-Control-Allow-Origin", origin);
	const vary = headers
		.get("Vary")
		?.split(",")
		.map((value) => value.trim().toLowerCase());
	if (!vary?.includes("origin")) {
		headers.append("Vary", "Origin");
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function preflightResponse(request: Request, requestId: string): Response {
	const origin = request.headers.get("Origin");
	const requestedMethod = request.headers
		.get("Access-Control-Request-Method")
		?.toUpperCase();
	const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") ?? "")
		.split(",")
		.map((header) => header.trim().toLowerCase())
		.filter(Boolean);
	const allowed =
		origin !== null &&
		ALLOWED_ORIGINS.has(origin) &&
		(requestedMethod === "GET" || requestedMethod === "POST") &&
		requestedHeaders.every((header) =>
			["content-type", "idempotency-key", "authorization"].includes(header),
		);

	if (!allowed) {
		return errorResponse(
			new ApiError(403, "CORS_NOT_ALLOWED", "CORS preflight is not allowed."),
			requestId,
		);
	}

	return new Response(null, {
		status: 204,
		headers: {
			"Access-Control-Allow-Origin": origin,
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type, Idempotency-Key, Authorization",
			"Access-Control-Max-Age": "600",
			"Cache-Control": "no-store",
			Vary: "Origin",
			"X-Request-Id": requestId,
		},
	});
}

async function readJsonBody(
	request: Request,
	maxBodyBytes: number,
): Promise<unknown> {
	const mediaType = request.headers
		.get("Content-Type")
		?.split(";", 1)[0]
		.trim()
		.toLowerCase();
	if (mediaType !== "application/json") {
		throw new ApiError(
			415,
			"UNSUPPORTED_MEDIA_TYPE",
			"Send the request body as application/json.",
		);
	}

	const reader = request.body?.getReader();
	if (!reader) {
		throw new ApiError(400, "INVALID_JSON", "A JSON request body is required.");
	}

	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		totalBytes += value.byteLength;
		if (totalBytes > maxBodyBytes) {
			throw new ApiError(
				413,
				"REQUEST_TOO_LARGE",
				`Request bodies must not exceed ${maxBodyBytes} bytes.`,
			);
		}
		chunks.push(value);
	}

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	try {
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
		);
	} catch {
		throw new ApiError(400, "INVALID_JSON", "The request body is not valid JSON.");
	}
}

async function readUrl(request: Request): Promise<string> {
	const body = await readJsonBody(request, MAX_PREVIEW_BODY_BYTES);
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new ApiError(400, "INVALID_REQUEST", "The request body must be an object.");
	}
	if (!("url" in body)) {
		throw new ApiError(400, "MISSING_URL", "The url field is required.");
	}
	if (typeof body.url !== "string") {
		throw new ApiError(400, "INVALID_REQUEST", "The url field must be a string.");
	}
	return body.url;
}

async function readProcessRequest(
	request: Request,
): Promise<{ url: string; transcript: UserProvidedTranscript | null }> {
	const body = await readJsonBody(request, MAX_PROCESS_BODY_BYTES);
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new ApiError(400, "INVALID_REQUEST", "The request body must be an object.");
	}
	if (!("url" in body)) {
		throw new ApiError(400, "MISSING_URL", "The url field is required.");
	}
	if (typeof body.url !== "string") {
		throw new ApiError(400, "INVALID_REQUEST", "The url field must be a string.");
	}
	if (!("fallback_transcript" in body)) {
		return { url: body.url, transcript: null };
	}

	const result = normalizeUserTranscript(body.fallback_transcript, MAX_PROCESS_BODY_BYTES);
	if (!result.ok) {
		const tooLarge = result.code === "REQUEST_TOO_LARGE";
		throw new ApiError(
			tooLarge ? 413 : 422,
			result.code,
			tooLarge
				? "The fallback transcript exceeds the allowed UTF-8 byte limit."
				: "Provide a non-empty fallback_transcript.text and an optional language string.",
		);
	}
	return { url: body.url, transcript: result.transcript };
}

async function enforceRateLimit(
	limiter: RateLimit,
	request: Request,
): Promise<void> {
	const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
	const { success } = await limiter.limit({ key: clientIp });
	if (!success) {
		throw new ApiError(
			429,
			"RATE_LIMITED",
			"Too many requests. Wait before trying again.",
			true,
		);
	}
}

function sourceError(
	code: "INVALID_URL" | "INVALID_YOUTUBE_URL" | "UNSUPPORTED_SOURCE",
) {
	const errors: Record<
		typeof code,
		{ status: number; message: string }
	> = {
		INVALID_URL: {
			status: 400,
			message: "Provide a valid HTTPS URL.",
		},
		INVALID_YOUTUBE_URL: {
			status: 422,
			message: "The URL is not a supported YouTube video URL.",
		},
		UNSUPPORTED_SOURCE: {
			status: 422,
			message: "Only YouTube video URLs are supported.",
		},
	};
	return new ApiError(errors[code].status, code, errors[code].message);
}

function methodNotAllowed(requestId: string, allow: string): Response {
	return jsonResponse(
		{
			error: {
				code: "METHOD_NOT_ALLOWED",
				message: "This HTTP method is not supported for the endpoint.",
				retryable: false,
				request_id: requestId,
			},
		},
		405,
		requestId,
		{ Allow: allow },
	);
}

function constantTimeEqual(left: string, right: string): boolean {
	const encoder = new TextEncoder();
	const leftBytes = encoder.encode(left);
	const rightBytes = encoder.encode(right);
	let difference = leftBytes.length ^ rightBytes.length;
	const length = Math.max(leftBytes.length, rightBytes.length);
	for (let index = 0; index < length; index += 1) {
		difference |=
			(leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
	}
	return difference === 0;
}

async function routeRequest(
	request: Request,
	requestId: string,
	env: WorkerEnvironment,
): Promise<Response> {
	const { pathname } = new URL(request.url);

	if (pathname === `${API_PREFIX}/admin/usage`) {
		if (request.method !== "GET" && request.method !== "POST") {
			return methodNotAllowed(requestId, "GET, POST, OPTIONS");
		}
		const expectedToken = env.AI_USAGE_ADMIN_TOKEN?.trim();
		if (!expectedToken) {
			throw new ApiError(
				503,
				"AI_USAGE_ADMIN_NOT_CONFIGURED",
				"AI usage administration is not configured.",
			);
		}
		const authorization = request.headers.get("Authorization");
		const presentedToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
		if (
			!presentedToken ||
			!constantTimeEqual(presentedToken, expectedToken)
		) {
			throw new ApiError(
				401,
				"AI_USAGE_ADMIN_UNAUTHORIZED",
				"Valid administrator authorization is required.",
			);
		}
		if (request.method === "POST") {
			const body = await readJsonBody(request, 8_192);
			if (
				typeof body !== "object" ||
				body === null ||
				Array.isArray(body) ||
				!("operation_id" in body) ||
				typeof body.operation_id !== "string" ||
				!/^[a-f0-9-]{36}$/.test(body.operation_id) ||
				!("actual_cost_usd" in body) ||
				typeof body.actual_cost_usd !== "number" ||
				!Number.isFinite(body.actual_cost_usd) ||
				body.actual_cost_usd < 0 ||
				body.actual_cost_usd > 1_000_000 ||
				!("provider_status" in body) ||
				(body.provider_status !== "succeeded" &&
					body.provider_status !== "failed")
			) {
				throw new ApiError(
					400,
					"INVALID_REQUEST",
					"Provide operation_id, non-negative actual_cost_usd, and provider_status (succeeded or failed).",
				);
			}
			const reconciliation = await reconcileAiUsage(
				env,
				body.operation_id,
				body.actual_cost_usd,
				body.provider_status,
			);
			return jsonResponse(
				{ api_version: "v1", reconciliation },
				200,
				requestId,
			);
		}
		return jsonResponse(
			{ api_version: "v1", usage: await getAiUsageSummary(env) },
			200,
			requestId,
		);
	}

	if (pathname === `${API_PREFIX}/health`) {
		if (request.method !== "GET") return methodNotAllowed(requestId, "GET, OPTIONS");
		return jsonResponse(
			{ status: "ok", api_version: "v1" },
			200,
			requestId,
		);
	}

	if (
		pathname === `${API_PREFIX}/recipes/preview` ||
		pathname === `${API_PREFIX}/recipes/process`
	) {
		if (request.method !== "POST") return methodNotAllowed(requestId, "POST, OPTIONS");

		if (pathname.endsWith("/preview")) {
			const result = identifyYouTubeUrl(await readUrl(request));
			if (!result.ok) throw sourceError(result.code);
			await enforceRateLimit(env.PREVIEW_RATE_LIMITER, request);
			const metadata = await resolveYouTubeMetadata(
				result.source,
				env.YOUTUBE_API_KEY,
			);
			return jsonResponse(
				{
					api_version: "v1",
					source: result.source,
					metadata,
					extraction: {
						status: "not_configured",
					},
				},
				200,
				requestId,
			);
		}

		const input = await readProcessRequest(request);
		const result = identifyYouTubeUrl(input.url);
		if (!result.ok) throw sourceError(result.code);
		await enforceRateLimit(env.PROCESS_RATE_LIMITER, request);
		if (!input.transcript) {
			throw new ApiError(
				503,
				"EXTRACTION_NOT_CONFIGURED",
				"Automatic transcript extraction is not configured. Provide fallback_transcript to generate a recipe.",
			);
		}

		const metadata = await resolveYouTubeMetadata(
			result.source,
			env.YOUTUBE_API_KEY,
		);
		const idempotencyKey =
			request.headers.get("Idempotency-Key")?.trim() || requestId;
		let jobId: string | null = null;
		let operationId: string | null = null;
		let reservationEstimate = 0;
		let providerAttemptCount = 0;
		let providerCallMayHaveBeenSent = false;
		try {
			const response = await processRecipe(
				result.source,
				metadata,
				input.transcript,
				env,
				fetch,
				25_000,
				{
					beforeProviderCall: async (
						_requestBody,
						estimatedCostUsd,
						providerOperationId,
					) => {
						const reserved = await reserveAiJob(
							env,
							idempotencyKey,
							estimatedCostUsd,
						);
						jobId = reserved.jobId;
						operationId = providerOperationId;
						reservationEstimate = estimatedCostUsd;
						await recordOpenRouterUsage(
							env,
							reserved.jobId,
							{
								operationId: providerOperationId,
								model: env.OPENROUTER_RECIPE_MODEL ?? "unknown",
								inputTokens: null,
								outputTokens: null,
								actualCostUsd: null,
								providerReference: null,
								attemptCount: 1,
								status: "started",
							},
							estimatedCostUsd,
						);
						providerAttemptCount = 1;
						providerCallMayHaveBeenSent = true;
					},
					onProviderUsage: async (usage, estimatedCostUsd) => {
						if (!jobId) {
							throw new ApiError(
								503,
								"USAGE_LEDGER_UNAVAILABLE",
								"AI usage tracking could not associate provider usage with this job.",
								true,
							);
						}
						await recordOpenRouterUsage(
							env,
							jobId,
							usage,
							estimatedCostUsd,
						);
					},
					onProviderRetry: async (
						providerOperationId,
						estimatedCostUsd,
						attemptCount,
					) => {
						if (!jobId) {
							throw new ApiError(
								503,
								"USAGE_LEDGER_UNAVAILABLE",
								"AI usage tracking could not associate a provider retry with this job.",
								true,
							);
						}
						operationId = providerOperationId;
						reservationEstimate = estimatedCostUsd;
						await recordOpenRouterUsage(
							env,
							jobId,
							{
								operationId: providerOperationId,
								model: env.OPENROUTER_RECIPE_MODEL ?? "unknown",
								inputTokens: null,
								outputTokens: null,
								actualCostUsd: null,
								providerReference: null,
								attemptCount,
								status: "started",
							},
							estimatedCostUsd,
						);
						providerAttemptCount = attemptCount;
					},
				},
			);
			if (!jobId) {
				throw new ApiError(
					503,
					"USAGE_LEDGER_UNAVAILABLE",
					"AI usage tracking did not create a recipe job.",
					true,
				);
			}
			const jobUsage = await finishAiJob(env, jobId, "completed");
			const processing = response.processing as Record<string, unknown>;
			return jsonResponse(
				{
					...response,
					processing: {
						...processing,
						job_id: jobId,
						cost_summary: {
							usage_operation_id: operationId,
							estimated_total_usd: jobUsage.estimatedCostUsd,
							actual_total_usd: jobUsage.actualCostUsd,
							reserved_usd: jobUsage.reservedCostUsd,
							status: jobUsage.status,
						},
					},
				},
				200,
				requestId,
			);
		} catch (error) {
			if (jobId) {
				try {
					const knownUnbilledFailure =
						error instanceof ApiError &&
						(error.code === "AI_PROVIDER_NOT_CONFIGURED" ||
							error.code === "AI_RATE_LIMITED");
					if (knownUnbilledFailure && operationId) {
						await recordOpenRouterUsage(
							env,
							jobId,
							{
								operationId,
								model: env.OPENROUTER_RECIPE_MODEL ?? "unknown",
								inputTokens: null,
								outputTokens: null,
								actualCostUsd: 0,
								providerReference: null,
								attemptCount: providerAttemptCount,
								status: "failed",
							},
							reservationEstimate,
						);
					}
					const holdReservation =
						providerCallMayHaveBeenSent &&
						error instanceof ApiError &&
						(error.code === "AI_TIMEOUT" ||
							error.code === "AI_PROCESSING_FAILED" ||
							error.code === "USAGE_LEDGER_UNAVAILABLE");
					await finishAiJob(env, jobId, "failed", holdReservation);
				} catch (ledgerError) {
					if (
						!(ledgerError instanceof ApiError) ||
						ledgerError.code !== "USAGE_LEDGER_UNAVAILABLE"
					) {
						throw ledgerError;
					}
				}
			}
			if (error instanceof ApiError && jobId) {
				throw new ApiError(
					error.status,
					error.code,
					error.message,
					error.retryable,
					error.retryAfterSeconds,
					jobId,
					operationId ?? undefined,
				);
			}
			throw error;
		}
	}

	throw new ApiError(404, "NOT_FOUND", "The requested API endpoint was not found.");
}

export async function handleApiRequest(
	request: Request,
	env: WorkerEnvironment,
): Promise<Response> {
	const requestId = crypto.randomUUID();
	const origin = request.headers.get("Origin");
	let response: Response;

	if (request.method === "OPTIONS") {
		response = preflightResponse(request, requestId);
	} else {
		try {
			response = await routeRequest(request, requestId, env);
		} catch (error) {
			if (error instanceof ApiError) {
				response = errorResponse(error, requestId);
			} else {
				console.error("Unhandled API error", {
					requestId,
					errorName: error instanceof Error ? error.name : "UnknownError",
				});
				response = errorResponse(
					new ApiError(500, "INTERNAL_ERROR", "An internal error occurred."),
					requestId,
				);
			}
		}
	}

	return applyCors(response, origin);
}
