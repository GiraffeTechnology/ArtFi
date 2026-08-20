import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ArtworkCard } from "@/components/artwork-card";
import { getProject, getProjectArtworks, projects } from "@/lib/catalog";

type PageProps = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return projects.map((project) => ({ slug: project.slug }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const project = getProject((await params).slug);
  return { title: project?.name ?? "Project" };
}

export default async function ProjectDetailPage({ params }: PageProps) {
  const project = getProject((await params).slug);
  if (!project) notFound();
  const projectArtworks = getProjectArtworks(project);

  return (
    <main className="page-shell page-main">
      <header
        className="project-hero"
        style={{ background: project.accent[0] }}
      >
        <div>
          <p className="eyebrow">Curated by {project.curator}</p>
          <h1>{project.name}</h1>
        </div>
        <div>
          <p>{project.thesis}</p>
          <dl>
            <div>
              <dt>Location</dt>
              <dd>{project.location}</dd>
            </div>
            <div>
              <dt>Documented works</dt>
              <dd>{projectArtworks.length}</dd>
            </div>
          </dl>
        </div>
      </header>
      <section className="section-block section-block--compact">
        <div className="section-heading">
          <p className="eyebrow">Project inventory</p>
          <h2>Records in this collection.</h2>
        </div>
        <div className="artwork-grid artwork-grid--two">
          {projectArtworks.map((artwork) => (
            <ArtworkCard artwork={artwork} key={artwork.slug} />
          ))}
        </div>
      </section>
    </main>
  );
}
