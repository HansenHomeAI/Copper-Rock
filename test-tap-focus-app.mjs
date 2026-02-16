#!/usr/bin/env node
import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

function getContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.html': return 'text/html; charset=utf-8';
        case '.js':
        case '.mjs': return 'application/javascript; charset=utf-8';
        case '.css': return 'text/css; charset=utf-8';
        case '.json': return 'application/json; charset=utf-8';
        case '.svg': return 'image/svg+xml';
        case '.png': return 'image/png';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.ico': return 'image/x-icon';
        case '.txt': return 'text/plain; charset=utf-8';
        default: return 'application/octet-stream';
    }
}

async function startStaticServer(rootDir) {
    const server = createServer(async (req, res) => {
        try {
            const rawPath = (req.url || '/').split('?')[0];
            const decodedPath = decodeURIComponent(rawPath);
            const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
            const resolvedPath = path.resolve(rootDir, relativePath);
            if (!resolvedPath.startsWith(rootDir)) {
                res.writeHead(403);
                res.end('Forbidden');
                return;
            }
            const stat = await fs.stat(resolvedPath);
            if (stat.isDirectory()) {
                res.writeHead(403);
                res.end('Forbidden');
                return;
            }
            res.writeHead(200, {
                'Content-Type': getContentType(resolvedPath),
                'Cache-Control': 'no-store'
            });
            createReadStream(resolvedPath).pipe(res);
        } catch (error) {
            res.writeHead(404);
            res.end('Not found');
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address !== 'object') {
        throw new Error('Could not start static server.');
    }
    return {
        server,
        baseUrl: `http://127.0.0.1:${address.port}`
    };
}

function distance3(a, b) {
    return Math.hypot(
        a.x - b.x,
        a.y - b.y,
        a.z - b.z
    );
}

async function waitForSceneReady(page, timeoutMs = 120000) {
    try {
        await page.waitForFunction(() => {
            return !!(
                window.__tapFocusDebug &&
                typeof window.__tapFocusDebug.getState === 'function' &&
                window.__cameraPathDebug &&
                typeof window.__cameraPathDebug.getCamera === 'function'
            );
        }, { timeout: 30000 });
    } catch (error) {
        const shape = await page.evaluate(() => ({
            tapFocusType: typeof window.__tapFocusDebug,
            cameraDebugType: typeof window.__cameraPathDebug
        })).catch(() => null);
        throw new Error(`Debug hooks unavailable within 30s: ${JSON.stringify(shape)}`);
    }

    await page.waitForFunction(() => {
        const state = window.__tapFocusDebug.getState();
        return state && state.activeLoaderPointCount > 100;
    }, { timeout: timeoutMs });
}

async function getSnapshot(page) {
    return page.evaluate(() => ({
        focus: window.__tapFocusDebug.getState(),
        camera: window.__cameraPathDebug.getCamera(),
        feedback: (() => {
            const el = document.getElementById('tap-focus-feedback');
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            const styles = getComputedStyle(el);
            const opacity = parseFloat(styles.opacity || '0');
            return {
                active: styles.display !== 'none' && opacity > 0.02,
                centerX: rect.left + rect.width * 0.5,
                centerY: rect.top + rect.height * 0.5,
                opacity,
                display: styles.display
            };
        })()
    }));
}

function validateAnimatedTapTransition(result, pointerType) {
    const totalMove = distance3(result.after.camera.target, result.before.camera.target);
    const earlyMove = distance3(result.early.camera.target, result.before.camera.target);
    const midMove = distance3(result.mid.camera.target, result.before.camera.target);
    if (!(totalMove > 0.01)) {
        throw new Error(`${pointerType} tap focus move too small (${totalMove.toFixed(5)}).`);
    }
    // Guard against instant hard jumps: early frame should not already equal final target.
    if (!(earlyMove < totalMove * 0.95)) {
        throw new Error(`${pointerType} tap focus appears non-animated (early=${earlyMove.toFixed(5)}, total=${totalMove.toFixed(5)}).`);
    }
    if (!(result.early.focus.transitionActive || result.mid.focus.transitionActive)) {
        throw new Error(`${pointerType} tap focus transition flag was never active.`);
    }
    if (!(midMove > earlyMove + 0.001)) {
        throw new Error(`${pointerType} tap focus did not progress smoothly (early=${earlyMove.toFixed(5)}, mid=${midMove.toFixed(5)}).`);
    }
    if (result.after.focus.transitionActive) {
        throw new Error(`${pointerType} tap focus transition did not settle after animation window.`);
    }
    const feedback = result.early.feedback;
    if (!feedback) {
        throw new Error(`${pointerType} tap feedback halo element was missing.`);
    }
    const haloDistance = Math.hypot(feedback.centerX - result.tap.x, feedback.centerY - result.tap.y);
    if (haloDistance > 36) {
        throw new Error(`${pointerType} tap feedback halo was misplaced (distance=${haloDistance.toFixed(2)}px).`);
    }
    if (!(feedback.active || feedback.opacity > 0.02)) {
        throw new Error(`${pointerType} tap feedback halo was not visible (active=${feedback.active}, opacity=${feedback.opacity}, display=${feedback.display}).`);
    }

    const midFeedback = result.mid.feedback;
    if (!midFeedback) {
        throw new Error(`${pointerType} mid-transition feedback snapshot missing.`);
    }
    const feedbackTravel = Math.hypot(midFeedback.centerX - feedback.centerX, midFeedback.centerY - feedback.centerY);
    if (feedbackTravel < 2) {
        throw new Error(`${pointerType} feedback ring did not track 3D focus point (travel=${feedbackTravel.toFixed(3)}px).`);
    }
}

async function attemptFocusByPointer(page, pointerType) {
    const viewport = page.viewportSize();
    if (!viewport) throw new Error('Viewport is unavailable.');
    const taps = [
        { x: Math.round(viewport.width * 0.22), y: Math.round(viewport.height * 0.34) },
        { x: Math.round(viewport.width * 0.78), y: Math.round(viewport.height * 0.34) },
        { x: Math.round(viewport.width * 0.5), y: Math.round(viewport.height * 0.62) },
        { x: Math.round(viewport.width * 0.34), y: Math.round(viewport.height * 0.72) }
    ];

    for (const tap of taps) {
        const before = await getSnapshot(page);
        if (pointerType === 'touch') {
            await page.touchscreen.tap(tap.x, tap.y);
        } else {
            await page.mouse.click(tap.x, tap.y);
        }
        await page.waitForTimeout(60);
        const early = await getSnapshot(page);
        await page.waitForTimeout(120);
        const mid = await getSnapshot(page);
        await page.waitForTimeout(280);
        const after = await getSnapshot(page);
        if (after.focus.successCount > before.focus.successCount) {
            const moved = distance3(after.camera.target, before.camera.target);
            if (moved > 0.01) {
                return {
                    tap,
                    viewport,
                    moved,
                    before,
                    early,
                    mid,
                    after
                };
            }
        }
    }
    return null;
}

async function runDesktopTest(context, baseUrl) {
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') {
            consoleErrors.push(`console.error: ${msg.text()}`);
        }
    });
    page.on('pageerror', (err) => {
        consoleErrors.push(`pageerror: ${err.message}`);
    });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForSceneReady(page);

    const focusResult = await attemptFocusByPointer(page, 'mouse');
    if (!focusResult) {
        const state = await getSnapshot(page);
        throw new Error(`Desktop tap focus did not move target. Last rejection reason: ${state.focus.lastRejectedReason || 'n/a'}. Errors: ${consoleErrors.join(' | ') || 'none'}`);
    }
    validateAnimatedTapTransition(focusResult, 'Desktop');

    const beforeUi = await getSnapshot(page);
    const clickedUi = await page.evaluate(() => {
        const detailsButton = document.getElementById('detailsButton');
        if (!detailsButton) return false;
        detailsButton.click();
        return true;
    });
    if (!clickedUi) {
        throw new Error('detailsButton is missing from DOM.');
    }
    await page.waitForTimeout(250);
    const afterUi = await getSnapshot(page);
    if (afterUi.focus.successCount !== beforeUi.focus.successCount) {
        throw new Error('UI button click unexpectedly triggered tap focus.');
    }
    await page.evaluate(() => {
        const detailsButton = document.getElementById('detailsButton');
        if (detailsButton) detailsButton.click();
    });
    await page.close();
    return focusResult;
}

async function runTouchTest(browser, baseUrl) {
    const context = await browser.newContext({
        viewport: { width: 430, height: 932 },
        isMobile: true,
        hasTouch: true,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') {
            consoleErrors.push(`console.error: ${msg.text()}`);
        }
    });
    page.on('pageerror', (err) => {
        consoleErrors.push(`pageerror: ${err.message}`);
    });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForSceneReady(page);
    const result = await attemptFocusByPointer(page, 'touch');
    await context.close();
    if (!result) {
        throw new Error(`Touch tap focus did not move target. Errors: ${consoleErrors.join(' | ') || 'none'}`);
    }
    validateAnimatedTapTransition(result, 'Touch');
    return result;
}

async function main() {
    const indexPath = path.join(repoRoot, 'index.html');
    const indexStats = await fs.stat(indexPath);
    const { server, baseUrl } = await startStaticServer(repoRoot);
    const browser = await chromium.launch({ headless: true });
    try {
        console.log(`Server: ${baseUrl}`);
        console.log(`Repo root: ${repoRoot}`);
        console.log(`Index bytes: ${indexStats.size}`);
        const desktopContext = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            ignoreHTTPSErrors: true
        });
        const desktopResult = await runDesktopTest(desktopContext, baseUrl);
        await desktopContext.close();
        console.log(`Desktop focus moved target by ${desktopResult.moved.toFixed(4)} at (${desktopResult.tap.x}, ${desktopResult.tap.y})`);

        const touchResult = await runTouchTest(browser, baseUrl);
        console.log(`Touch focus moved target by ${touchResult.moved.toFixed(4)} at (${touchResult.tap.x}, ${touchResult.tap.y})`);
        console.log('Tap-focus app test passed.');
    } finally {
        await browser.close();
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
}

main().catch((error) => {
    console.error('Tap-focus app test failed:', error.message);
    process.exit(1);
});
