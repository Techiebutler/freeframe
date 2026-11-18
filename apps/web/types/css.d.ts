/**
 * Side-effect CSS imports, which Next does not declare and TypeScript 5.6+ rejects.
 *
 * `app/layout.tsx` does `import "./globals.css"`. Next 14 ships no `*.css`
 * declaration (`next-env.d.ts` references only `next` and
 * `next/image-types/global`, and neither declares one), and since TS 5.6 a
 * side-effect import of a module with no declaration is TS2882 rather than
 * being ignored. So `tsc --noEmit` has been failing on `main`, and CI did not
 * say so because the Type check step was `continue-on-error`.
 *
 * Deliberately untyped: the one CSS import in this app is for its side effect
 * and binds no name, so there is nothing to describe. If CSS Modules ever
 * arrive, give `*.module.css` its own declaration returning
 * `Record<string, string>` before this wildcard swallows it as `any`.
 */
declare module "*.css";
