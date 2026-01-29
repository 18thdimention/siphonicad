# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Development commands

This is a Next.js 15 App Router project using TypeScript and Turbopack.

- Install dependencies (npm is implied by the presence of `package-lock.json`):
  - `npm install`
- Run the dev server (hot reload at http://localhost:3000):
  - `npm run dev`
- Create a production build:
  - `npm run build`
- Run the production server (after `npm run build`):
  - `npm run start`

### Linting and tests

- Testing is set up with **Vitest**.
- Run the full test suite:
  - `npm test`
- Run a specific test file (example for the projects API tests):
  - `npm test api/projects/route.test.ts`
- If you add linting (e.g. ESLint, `next lint`) or additional testing tools (e.g. Playwright), also add corresponding `npm run` scripts and update this section with:
  - How to run the full suite.
  - How to run an individual test file or test case.

## High‑level architecture

### Framework and tooling

- **Next.js App Router**:
  - Routing is under `app/` (e.g. `app/page.tsx`, `app/login/page.tsx`, `app/auth/callback/page.tsx`, `app/canvas/page.tsx`, `app/orgs/[orgId]/…`).
  - `next.config.ts` is present but currently only contains the default `nextConfig` export with a placeholder comment.
- **TypeScript**:
  - Strict mode is enabled via `tsconfig.json` with `"strict": true` and `"noEmit": true`.
  - The project uses a path alias `@/*` mapped to the repo root; many imports (e.g. `"@/components/ui/button"`, `"@/lib/supabaseClient"`) rely on this.
- **Styling**:
  - Tailwind CSS 4 and PostCSS 8+ are configured (see `postcss.config.mjs` and Tailwind-related dependencies in `package.json`).
  - UI primitives are built in a shadcn/radix style using class-variance-authority (`cva`) and a shared `cn` utility imported from `"@/lib/utils"` (note: that util file is not yet present in the repo).

### Routing and application flow

- **Landing page** (`app/page.tsx`):
  - Simple client component that renders a `TextHoverEffect` from `components/ui/text-hover-effect` and a "GET STARTED" button linking to `/login`.
- **Authentication flow**:
  - **Login page** (`app/login/page.tsx`):
    - Client component using Supabase magic-link authentication (`supabase.auth.signInWithOtp`).
    - Expects a `LoginForm` component from `"@/components/login-form"` to render the actual form; this component does not currently exist in the repo.
    - On submit, calls Supabase with `emailRedirectTo: ${window.location.origin}/auth/callback` and attaches `organization_code` in `user_metadata`.
  - **Auth callback** (`app/auth/callback/page.tsx`):
    - Handles post-magic-link login and redirects the user.
    - Uses `supabase.auth.getSession()` to hydrate the session from the URL hash.
    - If a session exists, calls `redirectUser(user)` which:
      - Reads `organization_code` from `user.user_metadata` and, if present, redirects to `/orgs/${organizationCode}`.
      - Otherwise queries Supabase table `organization_members` for a row with `user_id = user.id` and uses `organization_id` to redirect to `/orgs/${organization_id}`.
      - If no organization can be determined, falls back to `/dashboard`.
    - If no session is immediately available, registers an `onAuthStateChange` listener and also checks again after a short timeout, redirecting to `/login` if auth ultimately fails.
    - This page depends on a configured Supabase client from `"@/lib/supabaseClient"`, which is not present in the repo and must be implemented for auth to work.
- **Organizations and projects**:
  - **Project detail** (`app/orgs/[orgId]/projects/[projectId]/page.tsx`):
    - Client component that fetches a single project from Supabase table `projects` using filters `id = projectId` and `organization_id = orgId`.
    - Renders loading and "Project not found" states, and a `Card` UI component with project metadata (IDs and timestamps) once loaded.
  - **Org inbox and settings** (`app/orgs/[orgId]/inbox/page.tsx`, `app/orgs/[orgId]/settings/page.tsx`):
    - Both wrap content with a `SidebarProvider` from `components/ui/sidebar` and render a shared `AppSidebar` and `Header` component (both imported from `"@/components/..."` but not currently present in the repo).
    - These pages establish the shell/layout pattern for org-scoped views.
- **Canvas view** (`app/canvas/page.tsx`):
  - Renders a `CanvasMenubar` (from `"@/components/menubar"`) and an `IsometricCanvas` (from `"@/components/IsometricCanvas"`).
  - Both imported components are missing from the repository and should be created to make this route functional.
- **Documentation shell** (`app/documentation/page.tsx`):
  - Mirrors the org inbox/settings layout: wraps `AppSidebar` and `Header` inside the shared `SidebarProvider` and `SidebarInset`.

### UI component system (shadcn-style)

- All reusable UI primitives live under `components/ui/` and are generally thin wrappers around Radix UI primitives and Tailwind styles:
  - Layout and navigation:
    - `sidebar.tsx`: Complex, stateful sidebar system providing `SidebarProvider`, `Sidebar`, `SidebarInset`, `SidebarMenu*` primitives, keyboard shortcuts, mobile off-canvas behavior, and cookie-based persistence of sidebar open/closed state.
    - `menubar.tsx`: Menubar primitives (`Menubar`, `MenubarMenu`, `MenubarTrigger`, `MenubarItem`, etc.) wrapping `@radix-ui/react-menubar` and providing consistent styling and shortcuts.
    - `breadcrumb.tsx`: Declarative breadcrumb primitives (`Breadcrumb`, `BreadcrumbList`, `BreadcrumbItem`, `BreadcrumbLink`, `BreadcrumbPage`, etc.).
  - Surfaces and layout containers:
    - `card.tsx`: Card primitives (`Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`, `CardAction`) used for structured content like the project details page.
    - `dialog.tsx`: Dialog primitives (`Dialog`, `DialogTrigger`, `DialogContent`, etc.) wrapping `@radix-ui/react-dialog` with an overlay, centered content, and optional close button.
  - Inputs and buttons:
    - `button.tsx`: Primary button component using `cva` to define `variant` (`default`, `destructive`, `outline`, `secondary`, `ghost`, `link`) and `size` (`default`, `sm`, `lg`, `icon`, etc.) options.
    - `input.tsx`, `label.tsx`, `field.tsx`, and `separator.tsx` (not detailed here) provide consistent form and layout primitives.
  - Feedback and decoration:
    - `tooltip.tsx`: Tooltip primitives (`Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider`) based on `@radix-ui/react-tooltip`.
    - `skeleton.tsx`, `empty.tsx`, and `text-hover-effect.tsx` support loading states and animated text effects.
- All UI components rely heavily on a shared `cn` helper from `"@/lib/utils"` for conditional class merging and on Tailwind utility classes for styling.

### Data and actions layer

- `lib/actions/` contains placeholders intended for server actions or shared business logic around Supabase data:
  - `folderActions.ts`
  - `projectActions.ts`
  - `permissionActions.ts`
- These files are currently empty. When implementing actions here, keep them server-only where appropriate (e.g., `"use server"` in Next 13+ server actions) and have pages/components call into them rather than embedding Supabase queries in client components.

### Notable missing pieces and implications for agents

Several imports in the codebase point to modules that do **not** currently exist in the repository:

- Components:
  - `"@/components/IsometricCanvas"`
  - `"@/components/menubar"` (for `CanvasMenubar`)
  - `"@/components/app-sidebar"`
  - `"@/components/header"`
  - `"@/components/login-form"`
- Hooks and utilities:
  - `"@/hooks/use-mobile"` (used by `components/ui/sidebar.tsx`)
  - `"@/lib/utils"` (providing `cn` and possibly other helpers)
  - `"@/lib/supabaseClient"` (Supabase client used in login/auth/project pages)

When editing or extending the app, be aware that:

- **Build and runtime errors** will occur until these missing modules are implemented. If a task involves any of the pages that import them, first create the corresponding files and exports under the expected paths.
- The Supabase-facing code assumes certain tables and columns exist (`projects`, `organization_members`, etc.). Before performing data-related refactors or adding queries, confirm the actual database schema in Supabase and keep this file updated if conventions change.

If you introduce a test framework, Supabase helpers, or additional shared layout components, update `WARP.md` to describe the new commands and how those layers are structured.