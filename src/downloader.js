import axios from "axios";
import fs from "fs-extra";
import path from "path";

export async function downloadFile(url, filePath) {
    try {
        const response = await axios.get(url, { responseType: "arraybuffer" });
        await fs.ensureDir(path.dirname(filePath));
        await fs.writeFile(filePath, response.data);
    } catch (err) {
        console.error("Failed:", url, err.message);
    }
}