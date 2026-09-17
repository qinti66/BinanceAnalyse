const modules = [
  { href: "/square", label: "广场情绪", number: "01" },
  { href: "/indicators", label: "合约指标", number: "02" },
  { href: "/copy-trading", label: "带单双池", number: "03" },
] as const;

export function ModuleNav({ current }: { current?: string }) {
  return (
    <div className="module-navigation">
      <nav className="module-links" aria-label="分析模块">
        {modules.map(({ href, label, number }) => (
          <a key={href} href={href} aria-current={current === href ? "page" : undefined}>
            <span className="module-number" aria-hidden="true">{number}</span>
            {label}
          </a>
        ))}
      </nav>
      <a className="module-fusion" href="/cross-validation" aria-current={current==="/cross-validation"?"page":undefined}>交叉验证 ↗</a>
    </div>
  );
}
