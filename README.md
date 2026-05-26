# Kocode / ココーデ

> 大学生のための AI プログラミング TA

**Kocode** is a VS Code based AI programming tutor for university students in
Japan. It is designed to explain code and errors in approachable Japanese,
support Chinese-speaking international students, and help learners reach an
answer through hints instead of simply handing in generated solutions.

## Product Goal

Kocode aims to make introductory programming courses easier to learn without
replacing the student's thinking process. The first product milestone is a
usable VS Code extension MVP focused on learning support.

| Feature | Purpose |
| --- | --- |
| エラー解説 | Explain terminal and compiler errors in beginner-friendly Japanese. |
| コード説明 | Explain selected code clearly, including line-by-line guidance. |
| ヒントモード | Provide hints and next steps without immediately outputting a full answer. |
| 課題チェック | Check coursework code for obvious syntax, logic, naming, and omission issues. |
| 留学生サポート | Switch between Japanese and Chinese explanations. |
| 本気モード | Use stronger models selectively for difficult debugging tasks. |
| モデルルーティング | Route routine questions to lower-cost models and reserve costly calls for harder work. |

## Who It Serves

- Japanese university students learning Python, Java, C, or C++.
- Information science students who want faster, more understandable debugging.
- Students in data science courses who need accessible Python explanations.
- Chinese and other international students studying programming in Japanese.
- Students building portfolios while learning responsible AI-assisted development.

## Learning Principles

1. Explain the reason behind an error before proposing a fix.
2. Prefer guided hints in coursework contexts over complete generated answers.
3. Use clear Japanese by default and offer Chinese support when useful.
4. Control model cost through difficulty-aware routing and explicit advanced usage.

## Status

This repository is the initial Kocode fork and rebranding baseline. Current
work focuses on the VS Code extension under [`apps/vscode`](./apps/vscode).
Internal `cline.*` command IDs, protocol paths, service integrations, and SDK
package names are intentionally retained during the initial migration so the
upstream code remains buildable while Kocode-specific learning features are
developed.

Planned MVP work:

- Japanese-first explanation and error analysis UX.
- Hint mode and answer-withholding learning safeguards.
- Assignment check flows for common university programming languages.
- Japanese/Chinese language switching.
- Task difficulty classification and model routing controls.

## Development

The extension package lives in `apps/vscode`.

```bash
cd apps/vscode
npm run install:all
npm run compile
```

The fork tracks upstream through the `upstream` Git remote:

```bash
git fetch upstream
```

## Upstream And License

Kocode is derived from [Cline](https://github.com/cline/cline), an open-source
project licensed under the [Apache License 2.0](./LICENSE). Original copyright
and license notices are preserved. Kocode is an independent educational product
direction and is not represented as an official Cline release.
