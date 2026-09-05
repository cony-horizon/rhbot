/**
 * npm script の前に走る事前チェック。
 *
 * `tsx: command not found` のような、初心者には原因の分からないエラーで詰まらせないための仕組み。
 * 依存パッケージが無い状態を検出して、日本語で原因を説明し、可能なら自動で復旧する。
 *
 * 依存パッケージが無くても動く必要があるため、Node 標準機能だけで書く。
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const bin = process.platform === "win32" ? "tsx.cmd" : "tsx";
const tsxPath = path.join(root, "node_modules", ".bin", bin);

function say(lines) {
  console.error("\n" + lines.join("\n") + "\n");
}

/** 1. そもそも別のフォルダにいないか */
const pkgPath = path.join(root, "package.json");
if (!existsSync(pkgPath)) {
  say([
    "──────────────────────────────────────────",
    "  ⚠️  フォルダが違います",
    "──────────────────────────────────────────",
    "",
    `いまここにいます: ${root}`,
    "ここには package.json がありません。",
    "",
    "【対処】ダウンロードした rhbot フォルダに移動してから、もう一度実行してください。",
    "  Mac    : cd と半角スペースを打ってから、Finder でフォルダをターミナルにドラッグ＆ドロップ",
    "  Windows: エクスプローラーのアドレスバーのパスをコピーして  cd <貼り付け>",
    "",
    "移動できたか確認するには  ls  と入力します（package.json が並べば正解です）。",
  ]);
  process.exit(1);
}

/** 2. 依存パッケージが揃っているか */
if (existsSync(tsxPath)) process.exit(0);

const hasNodeModules = existsSync(path.join(root, "node_modules"));
say([
  "──────────────────────────────────────────",
  "  ⚠️  プログラムの部品が足りません",
  "──────────────────────────────────────────",
  "",
  hasNodeModules
    ? "node_modules はありますが、開発用の部品 (tsx) が入っていません。"
    : "まだ  npm install  が実行されていないようです。",
  "",
  "自動で入れ直します。1〜3 分ほどかかります…",
]);

// npm install --include=dev。NODE_ENV=production や npm config の production=true が
// 設定されている環境でも開発用の部品が入るように明示する。
const res = spawnSync("npm", ["install", "--include=dev"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, NODE_ENV: "development" },
});

if (res.status === 0 && existsSync(tsxPath)) {
  say(["✅ 部品をそろえました。処理を続けます。"]);
  process.exit(0);
}

say([
  "──────────────────────────────────────────",
  "  ❌ 自動での復旧に失敗しました",
  "──────────────────────────────────────────",
  "",
  "【手動での対処】ターミナルで次を 1 行ずつ実行してください。",
  "",
  "  npm install --include=dev",
  "",
  "それでも直らない場合、次のどれかに当てはまることが多いです。",
  "",
  "  ・インターネットに繋がっていない",
  "  ・Node.js のバージョンが古い  →  node -v  で v22.13 以上か確認",
  "  ・企業や学校のネットワークで npm がブロックされている",
  "",
  "赤い文字のエラーが出ていたら、その行をコピーして質問してください",
  "（トークンの文字列は消してから共有してください）。",
]);
process.exit(1);
