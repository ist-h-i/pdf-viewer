========================
X. Folder & File Structure (Common for all Angular versions)
========================

Follow a consistent, feature-based folder structure.
Assume a standard Angular workspace (one app), no Nx unless explicitly mentioned.

1) Top-level project layout

- project-root/
  - package.json
  - angular.json (or modern workspace config)
  - tsconfig*.json
  - src/
    - main.ts
    - index.html
    - styles.* (global styles, design tokens only)
    - app/
      - app.config.ts (providers, router, etc.)
      - core/
      - shared/
      - features/
      - environments/ (optional, or at src/environments)

2) app/core (Singletons & cross-cutting concerns)

- Purpose: app-wide singletons & infrastructure, never feature-specific UI.
- Typical structure:
  - src/app/core/
    - layout/
      - shell/
        - shell.component.ts|html|scss (app shell / layout)
    - services/
      - auth.service.ts
      - api-http.service.ts
      - logger.service.ts
    - interceptors/
      - auth.interceptor.ts
      - error.interceptor.ts
    - guards/
      - auth.guard.ts
    - config/
      - app-config.tokens.ts
    - util/
      - date-time.util.ts
- Rules:
  - `core` contains only SINGLETON services or global infrastructure.
  - Do NOT put feature-specific logic here.
  - Components in `core` are layout/shell-only (e.g. navigation, header, footer).

3) app/shared (Reusable, feature-agnostic building blocks)

- Purpose: small, reusable, UI and utility elements with no business semantics.
- Typical structure:
  - src/app/shared/
    - ui/
      - button/
        - button.component.ts|html|scss
      - card/
        - card.component.ts|html|scss
    - directives/
      - autofocus.directive.ts
      - scroll-into-view.directive.ts
    - pipes/
      - date-range.pipe.ts
      - truncate.pipe.ts
    - utils/
      - form-error.util.ts
- Rules:
  - `shared` MUST NOT depend on any feature folder.
  - `shared` UI components are “dumb” / presentational:
    - No feature-specific business logic.
    - Accept data via inputs, raise events via outputs.
  - Prefer “headless” components or directives for reusable behavior.

4) app/features (Feature-oriented vertical slices)

- Purpose: each domain feature (Todo, User, Settings, etc.) lives in its own folder.
- Typical structure:
  - src/app/features/
    - todo/
      - todo.routes.ts          (standalone route config for this feature)
      - todo.page.ts|html|scss  (main route host component)
      - components/
        - todo-list/
          - todo-list.component.ts|html|scss
        - todo-item/
          - todo-item.component.ts|html|scss
      - services/
        - todo.service.ts
        - todo.facade.ts (optional, for view-model / state handling)
      - models/
        - todo.model.ts
        - todo-status.enum.ts
      - state/ (optional)
        - todo.store.ts (signals or NgRx store)
      - __tests__/ (optional)
        - todo.page.spec.ts
        - todo.service.spec.ts
    - user/
      - user.routes.ts
      - user.page.ts|html|scss
      - components/
      - services/
      - models/
      - state/
- Rules:
  - Each feature folder owns its routing, pages, components, and services.
  - Pages (route-level components) live at the root of the feature folder (e.g. `todo.page.ts`).
  - Keep subfolders:
    - `components/` for smaller building-block components within that feature.
    - `services/` for feature-specific services/facades.
    - `models/` for domain models and enums.
    - `state/` or `store/` for feature state (signals, NgRx, etc.).
  - Do NOT create cross-feature imports directly between feature folders:
    - A feature may depend on `core` and `shared`.
    - Features should NOT depend directly on each other.
    - If something is shared between features, move it into `shared` or `core`.

5) Routing files per feature

- For each feature, create a dedicated route config file:
  - `todo.routes.ts`, `user.routes.ts`, etc.
- Route config file responsibilities:
  - Define `routes: Routes = [...]` for that feature.
  - Use standalone components (`loadComponent`, etc.).
  - Export the route array for use in the app-level router config.
- Do NOT mix route config and large business logic in the same file.

6) File & naming conventions

- Use kebab-case for folders and filenames:
  - `todo-list.component.ts`, `user-profile.page.ts`, `app-config.tokens.ts`
- Suffixes:
  - `*.component.ts`  for components
  - `*.page.ts`       for route-level components (pages)
  - `*.service.ts`    for services
  - `*.facade.ts`     for facade services (state/view-model orchestration)
  - `*.directive.ts`  for directives
  - `*.pipe.ts`       for pipes
  - `*.model.ts`      for domain models
  - `*.routes.ts`     for routing files
  - `*.store.ts` or `*.state.ts` for state containers
- Keep tests close to the code:
  - `*.spec.ts` next to the file under test, or inside a `__tests__/` folder at the feature root.
- Use barrel files (`index.ts`) sparingly:
  - Optional for re-exporting public API of a feature or shared module.
  - Do NOT create deep, confusing re-export chains.

7) Imports & dependency direction

- Allowed import directions:
  - `features/*` → `shared/*`, `core/*`
  - `shared/*`  → (no feature imports), maybe `core/*` if necessary
  - `core/*`    → (no feature imports)
- Forbidden:
  - `features/featureA` → `features/featureB`
  - `shared/*` → `features/*`
- If a piece of logic is used from multiple features:
  - Move it into `shared` (if UI-level or general utility).
  - Move it into `core` (if infrastructure-level or singleton service).
- Keep the dependency graph acyclic and top-down: core → shared → features.

8) Version-specific notes

- Angular 18:
  - Feature folders may still contain older NgModule-based code.
  - For new code, prefer standalone components but keep the folder structure above.
- Angular 19–21:
  - Assume fully standalone architecture; avoid new NgModules.
  - Route files (`*.routes.ts`) are the main entrypoint into each feature.

When generating code or examples:

- Always place files in the proper folder according to these rules.
- When showing a code snippet, briefly mention the intended path, e.g.:
  - `// File: src/app/features/todo/todo.page.ts`
  - `// File: src/app/shared/ui/button/button.component.ts`
This helps the reader keep the folder structure consistent.
