# Grammar Discovery

Interactive grammar modules for 11th-grade learners of English (Ukraine), built for asynchronous self-study using the **Guided Discovery** (inductive) approach. Students observe authentic examples, answer Concept Checking Questions, formulate the rule themselves, and only then unlock the grammar reference and practice exercises.

Content is adapted from *Karpiuk O. English (11th grade), 2019*: Conditionals I & II (pp. 23–25) and Reported Speech (pp. 101–103).

## Architecture

| Part | Where | What |
|---|---|---|
| Frontend | GitHub Pages (this repo) | Static HTML + Tailwind CSS (CDN) + vanilla JS, no build step |
| Backend | Google Apps Script Web App (`gas/`) | `doGet` (login) and `doPost` (answer check) |
| Database | Google Sheets | Tabs `Students`, `Lessons`, `Content`, `Attempts`, `Drafts`, `Practice`, `Teachers`, hidden `AnswerKey` |

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
- `index.html` – lists published lessons
- `lesson.html` – universal lesson page (`lesson.html?id=...`); `module1.html` / `module2.html` forward to it
- `assets/lesson-render.js` – draws a lesson from its data
- `assets/teacher-editor.js` – lesson editor in the teacher control center
- `teacher.html`, `assets/teacher.js`, `assets/teacher.css` – teacher control center
- `teacher-help.html` – guide for teachers: lesson structure, text formatting, every editor block, checks and settings
- `assets/app.js` – login modal, sticky header, shuffling, checking, unlocking
- `assets/styles.css` – shared components (Grammar Links boxes, exercises, confetti)
- `assets/config.js` – URL of the Apps Script Web App
- `gas/Code.gs` – backend API and one-time `setup()`
- `gas/reward_*.html` – original hand-written reward sections (used only for lessons without editor content)

## Creating lessons
In the teacher control center, open **Уроки** → **+ Новий урок** (or copy an existing lesson). Fill in the five steps, tick the correct answers, check the preview and press **Опублікувати**. The lesson appears on the home page immediately; the answer key is built from the ticked answers and stays on the server. Drafts are hidden from students.

## Teacher guide
Use the **teacher control center** (`teacher.html`, linked at the bottom of the home page). Log in with a teacher ID from the `Teachers` tab. It shows an overview per module (progress, hardest questions, practice results), every student's attempts with the real question texts, and lets you add or edit students, reset a student's progress and change module settings, so you don't need to edit the spreadsheet directly.

The settings below can also be changed directly in the spreadsheet:
- **Add students:** add rows to the `Students` tab (`student_id`, `student_name`, `class`).
- **Limit discovery attempts:** set `max_attempts` for the lesson (empty = unlimited). To give a student an extra attempt, raise it or delete their rows in `Attempts`.
- **Practice answers:** the `Practice` tab has one row per check, reveal or written submission, with the answers and score. `practice_reveal_after` (default 5; `0` = right away, `never` = never) sets after how many checks students may reveal the answers; `practice_max_checks` (empty = unlimited) limits the checks per exercise. Both limits are enforced by the server.
- **Teachers:** add rows to the `Teachers` tab (`teacher_id`, `teacher_name`).
- **See progress:** the `Attempts` tab has one row per check with the score (%), the answers and whether the attempt passed.
- **Change the answer key:** unhide the `AnswerKey` tab. Several accepted answers can be separated with `|`.
