import Link from "next/link";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/action-plan", label: "Action Plan" },
  { href: "/history", label: "History" },
  { href: "/brain", label: "Brain" },
  { href: "/config", label: "Config" },
];

export default function Nav() {
  return (
    <header className="border-b border-zinc-200 dark:border-zinc-800">
      <nav className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4">
        <span className="font-semibold tracking-tight text-black dark:text-zinc-50">
          Google Ads Agent Fleet
        </span>
        <div className="flex gap-4 text-sm">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
            >
              {link.label}
            </Link>
          ))}
        </div>
      </nav>
    </header>
  );
}
