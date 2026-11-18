import { Globe, Lock, PauseCircle } from "lucide-react";
import { useState } from "react";
import type { UserSiteItem } from "../../lib/types";
import { cn } from "../../lib/utils";

export function SitePreviewThumb({
  site,
  baseDomain,
  className,
}: {
  site: UserSiteItem;
  baseDomain: string;
  className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const hostLabel =
    site.customDomain && site.customDomainStatus === "verified"
      ? site.customDomain
      : `${site.slug}.${baseDomain}`;

  return (
    <div
      className={cn(
        "relative aspect-[16/10] w-full overflow-hidden rounded-lg border border-border bg-bg-subtle",
        className,
      )}
    >
      {site.visibility === "public" ? (
        <>
          {!loaded && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-2 text-center">
              <Globe size={16} className="text-faint" aria-hidden="true" />
              <span className="max-w-full truncate text-caption text-faint">
                {hostLabel}
              </span>
            </div>
          )}
          <iframe
            src={site.url}
            title={`${site.title} 预览`}
            sandbox="allow-scripts"
            loading="lazy"
            tabIndex={-1}
            onLoad={() => setLoaded(true)}
            className={cn(
              "pointer-events-none h-[400%] w-[400%] origin-top-left scale-[0.25] border-0 bg-white transition-opacity duration-200",
              loaded ? "opacity-100" : "opacity-0",
            )}
          />
        </>
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-2 text-center">
          {site.visibility === "password" ? (
            <Lock size={16} className="text-faint" aria-hidden="true" />
          ) : (
            <PauseCircle size={16} className="text-faint" aria-hidden="true" />
          )}
          <span className="max-w-full truncate text-caption text-faint">
            {site.visibility === "password" ? "口令保护" : "已下线"}
          </span>
        </div>
      )}
    </div>
  );
}
