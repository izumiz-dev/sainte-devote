# Code Style and Conventions

**Formatting (Prettier/ESLint):**
*   **Quotes:** Single quotes `'`
*   **Semi-colons:** Always `;`
*   **Indent:** 2 spaces
*   **Line Width:** 80 characters
*   **Var declaration:** `const` preferred, `no-var`.

**Linting:**
*   Run `pnpm lint` to check.
*   Run `pnpm lint:fix` to auto-fix.
*   Configured in `eslint.config.js` and `.prettierrc`.

**Coding Patterns:**
*   **Main Process:** Uses CommonJS `require`.
*   **Renderer Process:** Uses AMD `require` for Monaco modules.
*   **Global Variables:** `monaco` is global in renderer.
*   **Async/Await:** Used for DB operations and IPC.
*   **DOM Manipulation:** Vanilla JS (no heavy frontend frameworks like React/Vue).

**File Structure:**
*   `src/`: Application source code.
*   `assets/`: Icons and static assets.
*   `.serena/`: Agent memory and config.
