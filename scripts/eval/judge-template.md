# Judge prompt (fill in and paste into a separate agent run)

Replace every `{{...}}` below, delete this heading and the line under it, and paste the rest as the judge's prompt. Use a strong model, and not the model that wrote the answers.

---

You are judging answers from a search engine's eval run. You score; you do not change any file except the output file named below.

Repository: `{{REPO_PATH}}` (the Vane checkout).

1. Read `{{REPO_PATH}}/scripts/eval/JUDGE.md` in full before anything else. It holds every scoring rule and the exact output shape. Follow it exactly.
2. Fixtures (ground truth): `{{FIXTURES_PATH}}` (normally `scripts/eval/fixtures.json`).
3. Results files to judge, one per line as `label = path`. Use each label exactly as written in the `run` field:
   - `{{LABEL_1}}` = `{{RESULTS_PATH_1}}`
   - `{{LABEL_2}}` = `{{RESULTS_PATH_2}}`
4. Write the judgements to `{{OUTPUT_PATH}}` (JSONL, one line per run and finished fixture, all runs in one file).
5. Judging date (for run-day checks named in fixture notes): `{{DATE_UTC}}`.
6. Fixtures to judge: `{{ONLY_IDS}}` (write `all` for every fixture in the results).

When done, run the check in JUDGE.md ("Check before you finish"), with these flags:

```
node scripts/eval/compare.ts --run "{{LABEL_1}}={{RESULTS_PATH_1}}" --run "{{LABEL_2}}={{RESULTS_PATH_2}}" --judge {{OUTPUT_PATH}} --out {{COMPARE_HTML_PATH}}
```

Then reply with the report JUDGE.md asks for and nothing else.
