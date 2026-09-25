# Grammar Discovery

Interactive grammar modules for 11th-grade learners of English (Ukraine), built for asynchronous self-study using the **Guided Discovery** (inductive) approach. Students observe authentic examples, answer Concept Checking Questions, formulate the rule themselves, and only then unlock the grammar reference and practice exercises.

Content is adapted from *Karpiuk O. English (11th grade), 2019*: Conditionals I & II (pp. 23–25) and Reported Speech (pp. 101–103).

## Architecture

| Part | Where | What |
|---|---|---|
| Frontend | GitHub Pages (this repo) | Static HTML + Tailwind CSS (CDN) + vanilla JS, no build step |
| Backend | Google Apps Script Web App (`gas/`) | `doGet` (login) and `doPost` (answer check) |
| Database | Google Sheets | Tabs `Students`, `Lessons`, `Attempts`, `Practice`, `Teachers`, hidden `AnswerKey` |

### Lesson flow
1. **Observation** – a short text with the target structures highlighted.
2. **Analysis** – CCQs (multiple choice). Options are shuffled on every page load.
3. **Rule formulation** – the student completes the rule using dropdowns.
4. **Verification** – "Перевірити" sends the answers to the server. The server compares them with the `AnswerKey` tab, records the attempt in `Attempts`, and returns only the ids of wrong answers. After a fully correct attempt it also returns the reward section (Grammar Links tables + practice), which is then shown with a celebration animation.

### Anti-cheating design
- Correct answers are stored **only** in the spreadsheet (`AnswerKey` tab), never in this repository or in the page source.
- The grammar reference is not present in the page until the server sends it.
- Attempts are counted on the server. `max_attempts` per lesson in the `Lessons` tab is empty by default (unlimited); a teacher can set a limit.
- Limitations: students identify themselves by ID only (no password), and the practice exercises inside the reward are self-check exercises whose keys are delivered with the reward.

## Files
- `index.html` – module menu
- `teacher.html`, `assets/teacher.js`, `assets/teacher.css` – teacher control center
- `module1.html`, `module2.html` – lessons
- `assets/app.js` – login modal, sticky header, shuffling, checking, unlocking
- `assets/styles.css` – shared components (Grammar Links boxes, exercises, confetti)
- `assets/config.js` – URL of the Apps Script Web App
- `gas/Code.gs` – backend API and one-time `setup()`
- `gas/reward_*.html` – reward sections served after a correct attempt

## Teacher guide
Use the **teacher control center** (`teacher.html`, linked at the bottom of the home page). Log in with a teacher ID from the `Teachers` tab. It shows an overview per module (progress, hardest questions, practice results), every student's attempts with the real question texts, and lets you add or edit students, reset a student's progress and change module settings, so you don't need to edit the spreadsheet directly.

The settings below can also be changed directly in the spreadsheet:
- **Add students:** add rows to the `Students` tab (`student_id`, `student_name`, `class`).
- **Limit discovery attempts:** set `max_attempts` for the lesson (empty = unlimited). To give a student an extra attempt, raise it or delete their rows in `Attempts`.
- **Practice answers:** the `Practice` tab has one row per check, reveal or written submission, with the answers and score. `practice_reveal_after` (default 5; `0` = right away, `never` = never) sets after how many checks students may reveal the answers; `practice_max_checks` (empty = unlimited) limits the checks per exercise. Both limits are enforced by the server.
- **Teachers:** add rows to the `Teachers` tab (`teacher_id`, `teacher_name`).
- **See progress:** the `Attempts` tab has one row per check with the score (%), the answers and whether the attempt passed.
- **Change the answer key:** unhide the `AnswerKey` tab. Several accepted answers can be separated with `|`.
