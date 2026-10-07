import type { Metadata } from "next";

import { ProjectCard } from "@/components/project-card";
import { PrototypeDataNotice } from "@/components/prototype-data-notice";
import { projects } from "@/lib/catalog";

export const metadata: Metadata = { title: "Projects" };

export default function ProjectsPage() {
  return (
    <main className="page-shell page-main">
      <PrototypeDataNotice />
      <header className="page-intro">
        <p className="eyebrow">Curated projects</p>
        <h1>Context assembled before assets move.</h1>
        <p>
          Each project groups works by curatorial thesis while keeping
          authorship, material, location, and provenance visible at the asset
          level.
        </p>
      </header>
      <div className="project-list">
        {projects.map((project) => (
          <ProjectCard key={project.slug} project={project} />
        ))}
      </div>
    </main>
  );
}
