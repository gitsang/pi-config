import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PIXEL_FISHING_WIDTH = 80;
export const PIXEL_FISHING_ROWS = 7;
export const PIXEL_FISHING_FRAME_COUNT = 8;

const FRAMES_DIR = join(dirname(fileURLToPath(import.meta.url)), "pixel-frames");

function readFrameFile(file: string): string[] {
	const raw = readFileSync(join(FRAMES_DIR, file), "utf8");
	const rows = raw.split(/\r?\n/).filter((line) => line.length > 0);
	if (rows.length !== PIXEL_FISHING_ROWS) {
		throw new Error(`pi-fishing 像素帧 ${file} 应包含 ${PIXEL_FISHING_ROWS} 行，实际为 ${rows.length} 行`);
	}
	return rows;
}

/**
 * 读取 /tmp/fishing 那套 8 帧 truecolor 像素动画。
 * 每帧 7 行，每行 80 个半块字符。
 */
export function createPixelFishingFrames(): string[][] {
	const files = readdirSync(FRAMES_DIR)
		.filter((file) => file.endsWith(".ansi"))
		.sort((a, b) => a.localeCompare(b));
	if (files.length !== PIXEL_FISHING_FRAME_COUNT) {
		throw new Error(`pi-fishing 像素动画应包含 ${PIXEL_FISHING_FRAME_COUNT} 帧，实际为 ${files.length} 帧`);
	}
	return files.map(readFrameFile);
}
