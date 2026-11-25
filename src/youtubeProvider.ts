const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
	"youtube.com",
	"www.youtube.com",
	"m.youtube.com",
	"music.youtube.com",
	"youtu.be",
	"youtube-nocookie.com",
	"www.youtube-nocookie.com",
]);
const INSTAGRAM_HOSTS = new Set([
	"instagram.com",
	"www.instagram.com",
	"m.instagram.com",
]);

export type YouTubeSource = {
	platform: "youtube";
	original_url: string;
	normalized_url: string;
	video_id: string;
};

export type YouTubeUrlResult =
	| { ok: true; source: YouTubeSource }
	| {
			ok: false;
			code: "INVALID_URL" | "INVALID_YOUTUBE_URL" | "UNSUPPORTED_SOURCE";
	  };

export function identifyYouTubeUrl(rawUrl: string): YouTubeUrlResult {
	if (!rawUrl || rawUrl.length > 2048) {
		return { ok: false, code: "INVALID_URL" };
	}

	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return { ok: false, code: "INVALID_URL" };
	}

	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		(url.port && url.port !== "443")
	) {
		return { ok: false, code: "INVALID_URL" };
	}

	const host = url.hostname.toLowerCase();
	if (INSTAGRAM_HOSTS.has(host) || !YOUTUBE_HOSTS.has(host)) {
		return { ok: false, code: "UNSUPPORTED_SOURCE" };
	}

	let videoId: string | null = null;
	if (host === "youtu.be") {
		videoId = url.pathname.split("/").filter(Boolean)[0] ?? null;
		if (url.pathname.split("/").filter(Boolean).length !== 1) {
			videoId = null;
		}
	} else if (url.pathname === "/watch") {
		const ids = url.searchParams.getAll("v");
		videoId = ids.length === 1 ? ids[0] : null;
	} else if (
		host.endsWith("youtube-nocookie.com") &&
		url.pathname.startsWith("/embed/")
	) {
		videoId = url.pathname.slice("/embed/".length).split("/")[0] ?? null;
	} else {
		const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)\/?$/);
		videoId = match?.[1] ?? null;
	}

	if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) {
		return { ok: false, code: "INVALID_YOUTUBE_URL" };
	}

	return {
		ok: true,
		source: {
			platform: "youtube",
			original_url: rawUrl,
			normalized_url: `https://www.youtube.com/watch?v=${videoId}`,
			video_id: videoId,
		},
	};
}
