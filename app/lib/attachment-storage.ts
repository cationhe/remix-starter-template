const TOTAL_STORAGE_LIMIT_SETTING_KEY = "total_storage_limit_bytes";

const MIN_TOTAL_STORAGE_LIMIT_BYTES = 1 * 1024 * 1024 * 1024;
const MAX_TOTAL_STORAGE_LIMIT_BYTES = 100 * 1024 * 1024 * 1024;
const TOTAL_STORAGE_LIMIT_STEP_BYTES = 512 * 1024 * 1024;
const DEFAULT_TOTAL_STORAGE_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;

export const attachmentStorageLimits = {
	TOTAL_STORAGE_LIMIT_SETTING_KEY,
	MIN_TOTAL_STORAGE_LIMIT_BYTES,
	MAX_TOTAL_STORAGE_LIMIT_BYTES,
	TOTAL_STORAGE_LIMIT_STEP_BYTES,
	DEFAULT_TOTAL_STORAGE_LIMIT_BYTES,
} as const;

function clampTotalStorageLimitBytes(bytes: number) {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return DEFAULT_TOTAL_STORAGE_LIMIT_BYTES;
	}
	const snapped =
		Math.round(bytes / TOTAL_STORAGE_LIMIT_STEP_BYTES) *
		TOTAL_STORAGE_LIMIT_STEP_BYTES;
	return Math.min(
		MAX_TOTAL_STORAGE_LIMIT_BYTES,
		Math.max(MIN_TOTAL_STORAGE_LIMIT_BYTES, snapped),
	);
}

export function normalizeTotalStorageLimitBytes(bytes: number) {
	return clampTotalStorageLimitBytes(bytes);
}

export function formatTotalStorageLimit(bytes: number) {
	const base = 1024 * 1024 * 1024;
	const gb = bytes / base;
	const text = Number.isInteger(gb) ? String(gb) : gb.toFixed(1).replace(/\.0$/, "");
	return `${text}GB`;
}
