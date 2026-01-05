export type PostContentPart =
	| { type: "text"; text: string }
	| { type: "image"; imageId: number };

export function splitPostContentParts(content: string): PostContentPart[] {
	const raw = String(content ?? "");
	if (!raw) return [{ type: "text", text: "" }];

	const parts: PostContentPart[] = [];
	const re = /\[\[img:(\d+)\]\]/g;
	let lastIndex = 0;
	for (const match of raw.matchAll(re)) {
		const idx = match.index ?? 0;
		if (idx > lastIndex) {
			parts.push({ type: "text", text: raw.slice(lastIndex, idx) });
		}
		const token = match[0] || "";
		const n = Number(match[1]);
		const imageId = Number.isFinite(n) ? Math.floor(n) : NaN;
		if (imageId > 0) {
			parts.push({ type: "image", imageId });
		} else {
			parts.push({ type: "text", text: token });
		}
		lastIndex = idx + token.length;
	}
	if (lastIndex < raw.length) {
		parts.push({ type: "text", text: raw.slice(lastIndex) });
	}
	return parts;
}

export function extractPostContentImageIds(content: string): number[] {
	const parts = splitPostContentParts(content);
	const out: number[] = [];
	const seen = new Set<number>();
	for (const p of parts) {
		if (p.type !== "image") continue;
		const id = Math.floor(Number(p.imageId));
		if (!Number.isFinite(id) || id <= 0) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}
