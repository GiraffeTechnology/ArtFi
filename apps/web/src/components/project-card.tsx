import type { CSSProperties } from "react";
import Link from "next/link";

import { getProjectArtworks, type Project } from "@/lib/catalog";

export function ProjectCard({ project }: Readonly<{ project: Project }>) {
  const style = {
    "--project-a": project.accent[0],
    "--project-b": project.accent[1],
  } as CSSProperties;
  const assetCount = getProjectArtworks(project).length;

  return (
    <article className="project-card" style={style}>
      <div className="project-card__number" aria-hidden="true">
        {String(assetCount).padStart(2, "0")}
      </div>
      <div className="project-card__copy">
        <div className="card-kicker">
          <span>{project.location}</span>
          <span>{assetCount} works</span>
        </div>
        <h2>{project.name}</h2>
        <p>{project.thesis}</p>
        <Link className="text-link" href={`/projects/${project.slug}`}>
          View curated project <span aria-hidden="true">↗</span>
        </Link>
      </div>
    </article>
  );
}
