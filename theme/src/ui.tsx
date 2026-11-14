/**
 * The primitives every front end needs, so a card, a field and a tag mean the
 * same thing in the console as in the app. Anything specific to one product
 * stays in that product.
 */
import { Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import logoUrl from "../logo.png";
import { cn } from "./cn.js";

export const logo = logoUrl;

const themeListeners = new Set<() => void>();

/**
 * Dark mode is a `dark` class on `<html>`, set before paint by a script in
 * index.html, so that class — not React state — is the source of truth. The
 * key is the plain string "theme" on purpose: any other page on the same
 * origin that honours it inherits the visitor's choice for free.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const dark = useSyncExternalStore(
    (fn) => {
      themeListeners.add(fn);
      return () => themeListeners.delete(fn);
    },
    () => document.documentElement.classList.contains("dark"),
    () => false,
  );
  return (
    <button
      type="button"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => {
        const next = !dark;
        document.documentElement.classList.toggle("dark", next);
        try {
          localStorage.setItem("theme", next ? "dark" : "light");
        } catch {
          /* private windows still toggle, they just forget */
        }
        for (const l of themeListeners) l();
      }}
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-foreground/10 text-foreground/60 transition-colors hover:border-foreground/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

export function Logo({ className, wordmark = true }: { className?: string; wordmark?: boolean }) {
  return (
    <span className={cn("flex items-center gap-2 text-[17px] font-bold tracking-tight", className)}>
      <img src={logoUrl} alt="" aria-hidden className="h-8 w-8 shrink-0 object-contain" />
      {wordmark && (
        <span>
          Tron<span className="text-primary dark:text-primary-glow">Master</span>
        </span>
      )}
    </span>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-2xl border border-foreground/10 bg-card shadow-card", className)}>{children}</div>;
}

export const inputClass =
  "h-11 w-full rounded-xl border border-input bg-background px-3 text-sm text-foreground transition-colors placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";

export const textareaClass = cn(inputClass, "h-auto py-2 font-mono text-xs leading-relaxed");

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn("grid gap-1.5", className)}>
      <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-xs leading-relaxed text-muted-foreground">{hint}</span>}
    </label>
  );
}

export function Tag({ tone = "muted", className, children }: { tone?: "muted" | "on" | "pending" | "bad"; className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        tone === "on" && "border-primary/30 bg-primary/10 text-primary dark:text-primary-glow",
        tone === "pending" && "border-gold/50 bg-gold/15 text-[color:var(--gold-foreground)] dark:text-gold",
        tone === "bad" && "border-destructive/30 bg-destructive/10 text-destructive",
        tone === "muted" && "border-foreground/10 text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-foreground/[0.07]", className)} aria-hidden />;
}

/** The warning surface: gold, because red is for things that already failed. */
export function Notice({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-2xl border border-gold/40 bg-gold/[0.08] p-4 text-sm leading-relaxed", className)}>{children}</div>;
}
