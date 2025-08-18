import puppeteer from "puppeteer";
import fs from "fs-extra";
import path from "path";
import cliProgress from "cli-progress";
import {downloadFile} from "./downloader.js";
import {COLLECT_ONLY, DONE_FILE, MAX_DEPTH, MAX_PAGES, OUTPUT_DIR, saveProgress} from "./utils.js";
import {getNextProxy, loadProxies} from "./proxy.js";

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36";

loadProxies();

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(min = 2000, max = 5000) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function launchBrowserWithProxy() {
    const proxy = getNextProxy();
    const args = [];
    if (proxy) {
        args.push(`--proxy-server=${proxy.host}:${proxy.port}`);
    }

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-http2",
            "--disable-features=NetworkService",
            ...args
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
    });

    if (proxy?.user && proxy?.pass) {
        browser.on("targetcreated", async target => {
            try {
                const page = await target.page();
                if (page) {
                    await page.authenticate({
                        username: proxy.user,
                        password: proxy.pass
                    });
                }
                await page.setUserAgent(DEFAULT_UA);
            } catch {
            }
        });
    }
    return browser;
}

async function safeGoto(page, url, timeoutMs = 15000) {
    try {
        await Promise.race([
            page.goto(url, { waitUntil: "domcontentloaded", timeout: 0 }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error("ManualTimeout")), timeoutMs)
            )
        ]);
        return true;
    } catch (err) {
        console.warn(`⚠️ Goto failed for ${url}:`, err.message);
        return false;
    }
}

async function extractLinks(browser, url, baseDomain) {
    const page = await browser.newPage();
    try {
        const ok = await safeGoto(page, url, 15000); // timeout 15s
        if (!ok) return [];

        const links = await page.evaluate(() =>
            Array.from(document.querySelectorAll("a"))
                .map(a => a.href)
                .filter(href => href)
        );

        return links;
    } catch (err) {
        console.error(`❌ extractLinks failed for ${url}:`, err.message);
        return [];
    } finally {
        await page.close();
    }
}


async function processPage(targetUrl) {
    const browser = await launchBrowserWithProxy();
    const page = await browser.newPage();

    try {
        await page.goto(targetUrl, {waitUntil: "networkidle2", timeout: 60000});
    } catch (err) {
        console.error("Page failed:", targetUrl, err.message);
        await browser.close();
        return false;
    }

    let modifiedHtml = await page.content();

    const resources = await page.evaluate(() => {
        const urls = [];
        document.querySelectorAll("link[href]").forEach(el => urls.push(el.href));
        document.querySelectorAll("script[src]").forEach(el => urls.push(el.src));
        document.querySelectorAll("img[src]").forEach(el => urls.push(el.src));
        document.querySelectorAll("source[src], source[srcset]").forEach(el => {
            if (el.src) urls.push(el.src);
            if (el.srcset) urls.push(el.srcset);
        });
        return urls;
    });

    for (const url of resources) {
        try {
            const urlObj = new URL(url);
            if (url.match(/\.(css|js|png|jpe?g|gif|svg|ico|woff2?|ttf)$/i)) {
                const filePath = path.join(OUTPUT_DIR, urlObj.hostname, urlObj.pathname);
                await downloadFile(url, filePath);
                modifiedHtml = modifiedHtml.replaceAll(url, path.relative(OUTPUT_DIR, filePath));
            }
        } catch {
            console.error("Skip:", url);
        }
    }

    const urlObj = new URL(targetUrl);
    let savePath = path.join(OUTPUT_DIR, urlObj.hostname, urlObj.pathname);
    if (savePath.endsWith("/")) savePath = path.join(savePath, "index.html");
    else if (!path.extname(savePath)) savePath += ".html";

    await fs.ensureDir(path.dirname(savePath));
    await fs.writeFile(savePath, modifiedHtml);

    await browser.close();
    return true;
}

async function collectUrls(startUrl, maxPages, maxDepth = 3) {
    const browser = await launchBrowserWithProxy();
    const baseDomain = new URL(startUrl).hostname;
    const visited = new Set([startUrl]);
    const queue = [{url: startUrl, depth: 0}];

    while (queue.length > 0 && visited.size < maxPages) {
        const {url, depth} = queue.shift();
        if (depth >= maxDepth) continue; // không đi sâu hơn giới hạn

        const links = await extractLinks(browser, url, baseDomain);
        for (const link of links) {
            try {
                const linkDomain = new URL(link).hostname;
                // chỉ cho phép tiếp tục crawl nếu cùng domain
                if (linkDomain === baseDomain && !visited.has(link) && visited.size < maxPages) {
                    visited.add(link);
                    queue.push({url: link, depth: depth + 1});
                }
            } catch {
                // bỏ qua link lỗi parse
            }
        }
    }

    await browser.close();
    return Array.from(visited);
}


export async function cloneSite(startUrl) {
    const urls = await collectUrls(startUrl, MAX_PAGES, MAX_DEPTH);
    console.log("Collected URLs:", urls.length);

    const urlsFile = path.join(OUTPUT_DIR, "urls.txt");
    await fs.ensureDir(OUTPUT_DIR);
    await fs.writeFile(urlsFile, urls.join("\n"));
    console.log("Saved URL list to", urlsFile);

    if (COLLECT_ONLY) {
        console.log("Collect-only mode enabled. Exiting after saving URLs.");
        return;
    }

    // Đọc danh sách đã hoàn thành từ DONE_FILE
    let done = new Set();
    if (await fs.pathExists(DONE_FILE)) {
        const doneList = await fs.readFile(DONE_FILE, "utf-8");
        done = new Set(doneList.split("\n").filter(Boolean));
    }

    // Lọc ra danh sách URL chưa chạy
    const pending = urls.filter(u => !done.has(u));
    console.log("Pending URLs:", pending.length);

    const browser = await launchBrowserWithProxy();
    const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    bar.start(pending.length, 0);

    for (let i = 0; i < pending.length; i++) {
        const url = pending[i];
        let success = false;

        // Retry tối đa 3 lần
        for (let attempt = 1; attempt <= 3; attempt++) {
            success = await processPage(browser, url);
            if (success) break;
            console.warn(`Retry ${attempt}/3 failed for ${url}`);
        }

        if (success) {
            done.add(url);
            await saveProgress(done); // ghi ngay DONE_FILE để lưu trạng thái
        } else {
            console.error(`❌ Skip after 3 retries: ${url}`);
        }

        bar.update(i + 1);

        // 👉 Thêm delay ngẫu nhiên giữa các lần clone
        if (i < pending.length - 1) {
            const delay = randomDelay(2000, 5000);
            console.log(`⏳ Delay ${delay}ms trước khi clone trang tiếp theo...`);
            await sleep(delay);
        }
    }

    bar.stop();
    await browser.close();
    console.log("Clone finished! Total pages cloned:", done.size);
}