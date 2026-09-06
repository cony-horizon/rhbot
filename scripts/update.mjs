/**
 * 更新用スクリプト。`npm run update` から呼ばれる。
 *
 * GitHub 側が新しくなっても手元のファイルは自動では変わらないので、
 * 取得 → ビルドまでを 1 コマンドで済ませる。
 * .env と data/ には触れないため、設定と蓄積した履歴はそのまま残る。
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

function say(lines) {
  console.log("\n" + lines.join("\n") + "\n");
}

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
}

if (!existsSync(path.join(root, ".git"))) {
  say([
    "──────────────────────────────────────────",
    "  ⚠️  このフォルダは自動更新に対応していません",
    "──────────────────────────────────────────",
    "",
    "ZIP でダウンロードしたフォルダには更新の仕組みが入っていません。",
    "一度だけ次の手順を踏むと、以後は  npm run update  だけで済むようになります。",
    "",
    "【Mac の場合】ターミナルで 1 行ずつ実行してください。",
    "",
    "  cd ~/Desktop",
    "  git clone https://github.com/cony-horizon/rhbot.git rhbot-new",
    "  cd rhbot-new",
    `  cp "${root}/.env" .`,
    `  cp -r "${root}/data" .`,
    "  npm install",
    "  npm run build",
    "  npm start",
    "",
    "うまく動いたら、古いフォルダは削除して構いません。",
    "以後の更新は、ボットを Ctrl+C で止めてから  npm run update  →  npm start  だけです。",
  ]);
  process.exit(1);
}

say(["最新のコードを取得します…"]);
const pull = run("git", ["pull", "--ff-only"]);
if (pull.status !== 0) {
  say([
    "──────────────────────────────────────────",
    "  ❌ 取得に失敗しました",
    "──────────────────────────────────────────",
    "",
    "手元のファイルを直接編集していると、取得できないことがあります。",
    "（.env は対象外なので、設定を変えただけならこの原因ではありません）",
    "",
    "編集した覚えがなければ、次で手元の変更を捨ててから再実行してください。",
    "",
    "  git reset --hard origin/main",
    "  npm run update",
  ]);
  process.exit(1);
}

say(["部品を確認します…"]);
if (run("npm", ["install", "--include=dev"]).status !== 0) process.exit(1);

say(["ビルドします…"]);
if (run("npm", ["run", "build"]).status !== 0) process.exit(1);

say([
  "✅ 更新が完了しました。",
  "",
  "  npm start",
  "",
  "で起動してください。.env と data/（蓄積した履歴）はそのまま残っています。",
]);
