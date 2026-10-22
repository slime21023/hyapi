/** Match only declared route syntax before Elysia parses a protected body. */
export function routePattern(prefix: string, path: string): RegExp {
  const full = `${prefix === "/" ? "" : prefix}${path}`;
  const segments = full.split("/").map((segment) => {
    if (/^:[A-Za-z_]\w*$/.test(segment)) return "[^/]+";
    if (segment && !/^[-A-Za-z0-9._~%]+$/.test(segment))
      throw new Error(`Unsupported route segment '${segment}' in '${full}'.`);
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`^${segments.join("/").replace(/\/$/, "")}/?$`);
}

export function overlappingPaths(left: string, right: string): boolean {
  const first = left.replace(/\/$/, "").split("/");
  const second = right.replace(/\/$/, "").split("/");
  return (
    first.length === second.length &&
    first.every((segment, index) => {
      const other = second[index]!;
      return (
        segment.startsWith(":") ||
        other.startsWith(":") ||
        segment.toLowerCase() === other.toLowerCase()
      );
    })
  );
}
