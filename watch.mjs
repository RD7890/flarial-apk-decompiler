#!/usr/bin/env node
// ================================================================
//  Flarial APK Decompiler - GitHub Actions Watcher & Auto-Fixer
//  Watches the build → fetches logs on fail → fixes workflow → loops
//  Downloads artifacts on success → sends Termux notification
// ================================================================

import { Octokit } from "@octokit/rest";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { execSync, exec } from "child_process";
import { promisify } from "util";
import AdmZip from "adm-zip";

const execAsync = promisify(exec);

// ── Config ──────────────────────────────────────────────────────
const TOKEN    = process.env.GH_TOKEN;
if (!TOKEN) { console.error("❌ Set GH_TOKEN env var before running: export GH_TOKEN=your_pat"); process.exit(1); }
const OWNER    = "RD7890";
const REPO     = "flarial-apk-decompiler";
const WORKFLOW = "decompile.yml";
const OUTPUT_DIR = path.resolve(process.env.HOME, "Decompiled");
const POLL_INTERVAL_MS = 20_000;  // poll every 20s
const MAX_FIX_ATTEMPTS = 5;

// ── Colours ─────────────────────────────────────────────────────
const C = {
  reset : "\x1b[0m",
  green : "\x1b[32m",
  red   : "\x1b[31m",
  yellow: "\x1b[33m",
  cyan  : "\x1b[36m",
  bold  : "\x1b[1m",
  dim   : "\x1b[2m",
};

const log  = (msg) => console.log(`${C.cyan}[WATCH]${C.reset} ${msg}`);
const ok   = (msg) => console.log(`${C.green}[  OK  ]${C.reset} ${msg}`);
const warn = (msg) => console.log(`${C.yellow}[ WARN ]${C.reset} ${msg}`);
const err  = (msg) => console.log(`${C.red}[ FAIL ]${C.reset} ${msg}`);
const info = (msg) => console.log(`${C.dim}        ${msg}${C.reset}`);

// ── Octokit ──────────────────────────────────────────────────────
const octokit = new Octokit({ auth: TOKEN, request: { fetch } });

// ── Helpers ───────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sendTermuxNotification(title, body) {
  try {
    execSync(`termux-notification --title "${title}" --content "${body}" --sound --vibrate 500`);
    ok(`Termux notification sent: ${title}`);
  } catch (e) {
    warn(`Could not send Termux notification (termux-api installed?): ${e.message}`);
  }
}

function banner(text) {
  const line = "═".repeat(60);
  console.log(`\n${C.bold}${C.cyan}${line}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  ${text}${C.reset}`);
  console.log(`${C.bold}${C.cyan}${line}${C.reset}\n`);
}

// ── Trigger workflow ──────────────────────────────────────────────
async function triggerWorkflow() {
  log("Triggering decompile workflow via workflow_dispatch...");
  await octokit.actions.createWorkflowDispatch({
    owner: OWNER, repo: REPO,
    workflow_id: WORKFLOW,
    ref: "main",
  });
  ok("Workflow dispatched!");
  await sleep(5000); // give GitHub a moment to queue it
}

// ── Get latest run ────────────────────────────────────────────────
async function getLatestRun() {
  const { data } = await octokit.actions.listWorkflowRuns({
    owner: OWNER, repo: REPO,
    workflow_id: WORKFLOW,
    per_page: 1,
  });
  return data.workflow_runs[0] || null;
}

// ── Watch run until completion ─────────────────────────────────────
async function watchRun(runId) {
  banner(`Watching run #${runId}`);
  while (true) {
    const { data: run } = await octokit.actions.getWorkflowRun({
      owner: OWNER, repo: REPO, run_id: runId,
    });

    const status     = run.status;
    const conclusion = run.conclusion;
    const elapsed    = Math.round((Date.now() - new Date(run.created_at)) / 1000);

    process.stdout.write(
      `\r  ${C.yellow}⏳ Status: ${C.bold}${status}${C.reset}${C.yellow}  ` +
      `Elapsed: ${elapsed}s  ${C.dim}(checking every ${POLL_INTERVAL_MS/1000}s)${C.reset}   `
    );

    if (status === "completed") {
      console.log(); // newline after spinner
      return { conclusion, run };
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

// ── Fetch failed job logs ─────────────────────────────────────────
async function fetchFailedLogs(runId) {
  const { data: jobs } = await octokit.actions.listJobsForWorkflowRun({
    owner: OWNER, repo: REPO, run_id: runId,
  });

  let allLogs = "";
  for (const job of jobs.jobs) {
    if (job.conclusion === "failure") {
      err(`Failed job: "${job.name}"`);
      try {
        const { data: logData } = await octokit.actions.downloadJobLogsForWorkflowRun({
          owner: OWNER, repo: REPO, job_id: job.id,
        });
        // logData may be a URL redirect or text
        const logText = typeof logData === "string" ? logData : JSON.stringify(logData);
        // Extract last 100 lines for analysis
        const lines = logText.split("\n");
        const tail = lines.slice(-100).join("\n");
        allLogs += `\n=== JOB: ${job.name} ===\n${tail}\n`;
      } catch (e) {
        warn(`Could not fetch logs for job "${job.name}": ${e.message}`);
      }
    }
  }
  return allLogs;
}

// ── Analyze logs and apply fixes ──────────────────────────────────
async function analyzeAndFix(logs, attempt) {
  warn(`Analyzing failure logs (attempt ${attempt})...`);

  const workflowPath = path.resolve(__dirname, ".github/workflows/decompile.yml");
  let workflow = fs.readFileSync(workflowPath, "utf-8");
  let fixed = false;
  const fixes = [];

  // Fix: Ghidra version not found → try a known stable version
  if (logs.includes("setup-ghidra") || logs.includes("Ghidra") && logs.includes("404")) {
    workflow = workflow.replace(/version: '[\d.]+'/g, "version: '10.4'");
    fixes.push("Rolled back Ghidra to v10.4");
    fixed = true;
  }

  // Fix: JADX not found / 404
  if (logs.includes("jadx") && (logs.includes("404") || logs.includes("No such file"))) {
    workflow = workflow.replace(/JADX_VERSION="[\d.]+"/g, 'JADX_VERSION="1.4.7"');
    fixes.push("Rolled back JADX to v1.4.7");
    fixed = true;
  }

  // Fix: Apktool version issue
  if (logs.includes("apktool") && logs.includes("404")) {
    workflow = workflow.replace(/APKTOOL_VERSION="[\d.]+"/g, 'APKTOOL_VERSION="2.9.1"');
    fixes.push("Rolled back Apktool to v2.9.1");
    fixed = true;
  }

  // Fix: Java heap/OOM for Ghidra
  if (logs.includes("OutOfMemoryError") || logs.includes("Java heap")) {
    workflow = workflow.replace("-Xmx6g", "-Xmx8g");
    fixes.push("Increased Ghidra heap to 8GB");
    fixed = true;
  }

  // Fix: Ghidra script not found
  if (logs.includes("ExportDecompiledC.py") && logs.includes("not found")) {
    // Re-add the script path absolute
    workflow = workflow.replace(
      '-scriptPath "$(pwd)/ghidra_scripts"',
      '-scriptPath "$(pwd)/ghidra_scripts" -scriptPath "$(pwd)"'
    );
    fixes.push("Added fallback scriptPath for Ghidra");
    fixed = true;
  }

  // Fix: Permission denied on apktool
  if (logs.includes("Permission denied") && logs.includes("apktool")) {
    workflow = workflow.replace(
      "sudo chmod +x /usr/local/bin/apktool",
      "sudo chmod +x /usr/local/bin/apktool\n          sudo chmod +x /usr/local/bin/apktool.jar"
    );
    fixes.push("Fixed apktool permission issue");
    fixed = true;
  }

  // Fix: unzip not installed
  if (logs.includes("unzip: command not found")) {
    workflow = workflow.replace(
      "- name: Extract .so files from config.arm64_v8a.apk",
      "- name: Install unzip\n        run: sudo apt-get install -y unzip\n\n      - name: Extract .so files from config.arm64_v8a.apk"
    );
    fixes.push("Added unzip installation step");
    fixed = true;
  }

  if (fixes.length > 0) {
    fs.writeFileSync(workflowPath, workflow);
    ok(`Applied ${fixes.length} fix(es): ${fixes.join(", ")}`);
    // Commit and push the fix
    execSync(`cd "${__dirname}" && git add .github/workflows/decompile.yml && git commit -m "🔧 Auto-fix attempt ${attempt}: ${fixes.join(', ')}" && git push`, { stdio: "inherit" });
    return true;
  }

  if (!fixed) {
    warn("No automatic fix found for these errors. Saving logs for manual review...");
    fs.writeFileSync(path.resolve(__dirname, `failure-logs-attempt-${attempt}.txt`), logs);
    err("Could not auto-fix. Check failure-logs-attempt-*.txt");
  }

  return fixed;
}

// ── Download artifacts ────────────────────────────────────────────
async function downloadArtifacts(runId) {
  banner("Downloading Decompiled Artifacts");

  const { data: artData } = await octokit.actions.listWorkflowRunArtifacts({
    owner: OWNER, repo: REPO, run_id: runId,
  });

  if (artData.artifacts.length === 0) {
    warn("No artifacts found for this run.");
    return;
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const artifact of artData.artifacts) {
    log(`Downloading artifact: ${C.bold}${artifact.name}${C.reset} (${(artifact.size_in_bytes / 1024 / 1024).toFixed(1)} MB)...`);

    const { url } = await octokit.actions.downloadArtifact({
      owner: OWNER, repo: REPO,
      artifact_id: artifact.id,
      archive_format: "zip",
    }).then(r => ({ url: r.url })).catch(async (e) => {
      // Octokit follows redirect — extract URL from headers
      if (e.status === 302) return { url: e.response?.headers?.location };
      throw e;
    });

    // Fetch the zip
    const resp = await fetch(url || artifact.archive_download_url, {
      headers: { Authorization: `token ${TOKEN}` },
      redirect: "follow",
    });

    if (!resp.ok) throw new Error(`Failed to download: ${resp.statusText}`);

    const buffer = Buffer.from(await resp.arrayBuffer());
    const zipPath = path.join(OUTPUT_DIR, `${artifact.name}.zip`);
    fs.writeFileSync(zipPath, buffer);

    // Extract into named folder
    const extractDir = path.join(OUTPUT_DIR, artifact.name);
    fs.mkdirSync(extractDir, { recursive: true });
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractDir, true);
    fs.unlinkSync(zipPath); // remove zip after extraction

    ok(`Saved to: ${extractDir}`);
  }

  // Show summary tree
  console.log(`\n${C.bold}📁 Output Directory: ${OUTPUT_DIR}${C.reset}`);
  try {
    const tree = execSync(`find "${OUTPUT_DIR}" -maxdepth 3 -type d`).toString();
    console.log(tree);
  } catch (_) {}
}

// ── Main Loop ─────────────────────────────────────────────────────
async function main() {
  banner("🔬 Flarial APK Decompiler — Auto-Watch & Fix");
  log(`Repo: https://github.com/${OWNER}/${REPO}`);
  log(`Output: ${OUTPUT_DIR}`);
  console.log();

  let fixAttempts = 0;

  // Trigger first run
  await triggerWorkflow();

  while (true) {
    const run = await getLatestRun();
    if (!run) {
      warn("No workflow run found yet. Waiting...");
      await sleep(10000);
      continue;
    }

    log(`Run ID: ${run.id} | URL: ${run.html_url}`);
    const { conclusion } = await watchRun(run.id);

    console.log();

    if (conclusion === "success") {
      banner("✅ BUILD SUCCEEDED!");
      ok("All decompilation jobs passed.");
      await downloadArtifacts(run.id);
      sendTermuxNotification(
        "✅ Flarial Decompilation Done!",
        "All APKs decompiled. Check ~/Decompiled for results."
      );
      break;

    } else {
      err(`Build ${conclusion.toUpperCase()}! (Attempt ${fixAttempts + 1}/${MAX_FIX_ATTEMPTS})`);
      sendTermuxNotification("⚠️ Build Failed", `Attempt ${fixAttempts + 1} failed. Auto-fixing...`);

      if (fixAttempts >= MAX_FIX_ATTEMPTS) {
        err(`Reached max fix attempts (${MAX_FIX_ATTEMPTS}). Stopping.`);
        sendTermuxNotification("❌ Auto-Fix Exhausted", `Failed after ${MAX_FIX_ATTEMPTS} attempts.`);
        process.exit(1);
      }

      const logs = await fetchFailedLogs(run.id);
      const fixed = await analyzeAndFix(logs, ++fixAttempts);

      if (fixed) {
        log("Fix pushed. Waiting for new workflow run to start...");
        await sleep(15000);
        await triggerWorkflow();
      } else {
        err("Cannot auto-fix. Manual review required.");
        process.exit(1);
      }
    }
  }
}

// Store __dirname equivalent for ESM
import { fileURLToPath } from "url";
import { dirname }       from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

main().catch(e => {
  err(`Fatal: ${e.message}`);
  console.error(e);
  process.exit(1);
});
