# tylix-deploy

A deployer for Tylix apps (and later Laravel, Next.js, and React), built with Tylix itself.

## Setup

```bash
cp .env.example .env     # fill in DATABASE_* and AUTH_SECRET
npm install
npx tylix migrate
npm run dev
```

## Workflow

- `main` is always deployable
- Solo project: commit small and often straight to `main`
- Conventional Commits (`feat:`, `fix:`, `chore:`)
- Tagged `v0.x.0` at the end of each roadmap phase
