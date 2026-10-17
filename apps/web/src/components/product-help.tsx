import Link from "next/link";
import { helpSections } from "@/lib/help-content";
import styles from "./administration.module.css";

export function ProductHelp() {
  return (
    <div className={styles.workspace}>
      <nav aria-label="Help topics" className={styles.panel}>
        <h2>Browse help topics</h2>
        <ul>
          {helpSections.map((section) => (
            <li key={section.id}>
              <a href={"#" + section.id}>{section.title}</a>
            </li>
          ))}
        </ul>
      </nav>
      {helpSections.map((section) => (
        <section
          key={section.id}
          id={section.id}
          aria-labelledby={section.id + "-title"}
          className={styles.panel}
        >
          <h2 id={section.id + "-title"}>{section.title}</h2>
          {section.questions.map((question) => (
            <details
              key={question.id}
              id={question.id}
              className={styles.record}
            >
              <summary>
                <strong>{question.question}</strong>
              </summary>
              {question.paragraphs.map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
              {"links" in question && (
                <ul aria-label="Related workflows">
                  {question.links.map((link) => (
                    <li key={link.href}>
                      <Link href={link.href}>{link.label}</Link>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          ))}
        </section>
      ))}
      <p className={styles.muted}>
        This public guide does not read wallet data, grant authority or confirm
        an operation's outcome. Use the corresponding protected workflow for
        current account and transaction information.
      </p>
    </div>
  );
}
