import { cloneSite } from "./src/cloner.js";

const target = process.argv[2] || "https://example.com";
cloneSite(target).then();