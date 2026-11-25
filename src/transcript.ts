export type UserProvidedTranscript = {
	text: string;
	language: string | null;
	source: "user_provided";
};

export type TranscriptInputErrorCode = "INVALID_TRANSCRIPT" | "REQUEST_TOO_LARGE";

export type TranscriptInputResult =
	| { ok: true; transcript: UserProvidedTranscript }
	| { ok: false; code: TranscriptInputErrorCode };

export function normalizeUserTranscript(
	value: unknown,
	maxBytes: number,
): TranscriptInputResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, code: "INVALID_TRANSCRIPT" };
	}
	const input = value as Record<string, unknown>;

	if (!("text" in input) || typeof input.text !== "string") {
		return { ok: false, code: "INVALID_TRANSCRIPT" };
	}

	if (
		"language" in input &&
		input.language !== null &&
		typeof input.language !== "string"
	) {
		return { ok: false, code: "INVALID_TRANSCRIPT" };
	}

	const text = input.text.replace(/\r\n?/g, "\n").trim();
	if (!text) {
		return { ok: false, code: "INVALID_TRANSCRIPT" };
	}

	if (new TextEncoder().encode(text).byteLength > maxBytes) {
		return { ok: false, code: "REQUEST_TOO_LARGE" };
	}

	const language =
		typeof input.language === "string" && input.language.trim()
			? input.language.trim()
			: null;
	if (language && language.length > 64) {
		return { ok: false, code: "INVALID_TRANSCRIPT" };
	}

	return {
		ok: true,
		transcript: {
			text,
			language,
			source: "user_provided",
		},
	};
}
