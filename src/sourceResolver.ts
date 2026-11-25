import type { YouTubeSource } from "./youtubeProvider";

export type YouTubeMetadata = {
	status: "available" | "unavailable" | "not_configured";
	video_title: string | null;
	creator: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function resolveYouTubeMetadata(
	source: YouTubeSource,
	apiKey: string | undefined,
): Promise<YouTubeMetadata> {
	if (!apiKey) {
		return {
			status: "not_configured",
			video_title: null,
			creator: null,
		};
	}

	const apiUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
	apiUrl.searchParams.set("part", "snippet");
	apiUrl.searchParams.set("id", source.video_id);
	apiUrl.searchParams.set("key", apiKey);
	apiUrl.searchParams.set("fields", "items(snippet(title,channelTitle))");

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 5000);
	try {
		const response = await fetch(apiUrl, { signal: controller.signal });
		if (!response.ok) {
			return {
				status: "unavailable",
				video_title: null,
				creator: null,
			};
		}

		const payload: unknown = await response.json();
		if (!isRecord(payload) || !Array.isArray(payload.items)) {
			return {
				status: "unavailable",
				video_title: null,
				creator: null,
			};
		}

		const firstItem = payload.items[0];
		const snippet =
			isRecord(firstItem) && isRecord(firstItem.snippet)
				? firstItem.snippet
				: null;
		if (!snippet) {
			return {
				status: "unavailable",
				video_title: null,
				creator: null,
			};
		}

		const title = typeof snippet.title === "string" ? snippet.title : null;
		const creator =
			typeof snippet.channelTitle === "string" ? snippet.channelTitle : null;
		return {
			status: title || creator ? "available" : "unavailable",
			video_title: title,
			creator,
		};
	} catch {
		return {
			status: "unavailable",
			video_title: null,
			creator: null,
		};
	} finally {
		clearTimeout(timeoutId);
	}
}
