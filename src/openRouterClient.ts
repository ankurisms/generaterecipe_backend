import { ApiError } from "./apiErrors";

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MAX_RETRY_AFTER_MS = 2_000;
const DEFAULT_RETRY_DELAY_MS = 250;

export type OpenRouterConfig = {
	apiKey?: string;
	model?: string;
};

export type OpenRouterCompletion = {
	payload: unknown;
	attemptCount: number;
};

export function getBoundedRetryDelayMs(
	retryAfter: string | null,
	now: number,
): number {
	if (!retryAfter) return DEFAULT_RETRY_DELAY_MS;

	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
	}

	const date = Date.parse(retryAfter);
	if (Number.isNaN(date)) return DEFAULT_RETRY_DELAY_MS;
	return Math.min(Math.max(0, date - now), MAX_RETRY_AFTER_MS);
}

function isRetryableStatus(status: number): boolean {
	// A 5xx can be returned after upstream inference has started; retrying it
	// without provider-side idempotency could create a second billable generation.
	return status === 429;
}

export async function requestOpenRouterCompletion(
	config: OpenRouterConfig,
	requestBody: unknown,
	fetcher: typeof fetch = fetch,
	timeoutMs = 25_000,
	onRetry?: (attemptCount: number) => Promise<void>,
): Promise<OpenRouterCompletion> {
	const apiKey = config.apiKey?.trim();
	const model = config.model?.trim();
	if (!apiKey || !model) {
		throw new ApiError(
			503,
			"AI_PROVIDER_NOT_CONFIGURED",
			"Recipe generation is not configured. Set the OpenRouter Worker credentials and model.",
		);
	}

	const body =
		typeof requestBody === "object" && requestBody !== null
			? { ...(requestBody as Record<string, unknown>), model }
			: { model };
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		let response: Response | undefined;
		let attemptCount = 0;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			attemptCount += 1;
			if (attemptCount > 1) await onRetry?.(attemptCount);
			try {
				response = await fetcher(OPENROUTER_ENDPOINT, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
					signal: controller.signal,
				});
			} catch {
				if (controller.signal.aborted) {
					throw new ApiError(
						504,
						"AI_TIMEOUT",
						"Recipe generation timed out. Try again.",
						true,
					);
				}
				throw new ApiError(
					502,
					"AI_PROCESSING_FAILED",
					"The recipe generation provider could not be reached.",
					true,
				);
			}

			if (response.ok) break;
			if (attempt === 0 && isRetryableStatus(response.status)) {
				const delay = getBoundedRetryDelayMs(
					response.headers.get("Retry-After"),
					Date.now(),
				);
				try {
					await response.body?.cancel();
				} catch {
					// The response is discarded before the single bounded retry.
				}
				await new Promise<void>((resolve) => setTimeout(resolve, delay));
				if (controller.signal.aborted) {
					throw new ApiError(
						504,
						"AI_TIMEOUT",
						"Recipe generation timed out. Try again.",
						true,
					);
				}
				continue;
			}

			if (response.status === 401 || response.status === 403) {
				throw new ApiError(
					503,
					"AI_PROVIDER_NOT_CONFIGURED",
					"Recipe generation credentials were rejected. Check the Worker secret.",
				);
			}
			if (response.status === 429) {
				throw new ApiError(
					503,
					"AI_RATE_LIMITED",
					"The recipe generation provider is temporarily rate-limiting requests.",
					true,
				);
			}
			throw new ApiError(
				502,
				"AI_PROCESSING_FAILED",
				"The recipe generation provider could not complete the request.",
				true,
			);
		}

		if (!response?.ok) {
			throw new ApiError(
				502,
				"AI_PROCESSING_FAILED",
				"The recipe generation provider could not complete the request.",
				true,
			);
		}

		try {
			return {
				payload: await response.json(),
				attemptCount,
			};
		} catch {
			if (controller.signal.aborted) {
				throw new ApiError(
					504,
					"AI_TIMEOUT",
					"Recipe generation timed out. Try again.",
					true,
				);
			}
			throw new ApiError(
				502,
				"AI_PROCESSING_FAILED",
				"The recipe generation provider returned an invalid response.",
				true,
			);
		}
	} finally {
		clearTimeout(timeoutId);
	}
}

export async function getOpenRouterReportedCost(
	apiKey: string,
	generationId: string,
	fetcher: typeof fetch = fetch,
	timeoutMs = 1_500,
): Promise<number | null> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetcher(
			`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`,
			{
				method: "GET",
				headers: { Authorization: `Bearer ${apiKey}` },
				signal: controller.signal,
			},
		);
		if (!response.ok) return null;
		const payload: unknown = await response.json();
		if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
			return null;
		}
		const data = (payload as Record<string, unknown>).data;
		if (typeof data !== "object" || data === null || Array.isArray(data)) {
			return null;
		}
		const totalCost = (data as Record<string, unknown>).total_cost;
		return typeof totalCost === "number" &&
			Number.isFinite(totalCost) &&
			totalCost >= 0
			? totalCost
			: null;
	} catch {
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}
