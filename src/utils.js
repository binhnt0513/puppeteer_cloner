import path from "path";
import fs from "fs-extra";

const target = process.argv[2] || "https://example.com";
const hostname = new URL(target).hostname;

export const OUTPUT_DIR = path.resolve(`./${hostname}`);

const maxPagesArg = process.argv.find(arg => arg.startsWith("--max-pages="));
export const MAX_PAGES = maxPagesArg ? parseInt(maxPagesArg.split("=")[1], 10) : 50;

const maxDepthArg = process.argv.find(arg => arg.startsWith("--max-depth="));
export const MAX_DEPTH = maxDepthArg ? parseInt(maxDepthArg.split("=")[1], 10) : 3;

export const COLLECT_ONLY = process.argv.includes("--collect-only");
export const DONE_FILE = path.join(OUTPUT_DIR, "done.txt");

export async function saveProgress(done) {
    await fs.writeFile(DONE_FILE, Array.from(done).join("\n"));
}
