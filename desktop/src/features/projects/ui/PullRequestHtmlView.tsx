import { Eye } from "lucide-react";
import * as React from "react";

import type {
  ProjectPullRequest,
  Repository as Project,
} from "@/features/projects/hooks";
import { getProjectRepoFileContent } from "@/shared/api/projectGit";
import type { ProjectRepoDiffFile } from "@/shared/api/types";
import { isHtmlFilename } from "@/shared/ui/markdown/htmlReport";
import { HtmlReportDialog } from "@/shared/ui/markdown/HtmlReportDialog";

const MAX_RENDER_BYTES = 8 * 1024 * 1024;

function isDeletedFile(file: ProjectRepoDiffFile) {
  return /^\+\+\+ \/dev\/null$/m.test(file.patch);
}

/** Renders an HTML file as it stands at the pull request's commit. */
export function PullRequestHtmlViewButton({
  file,
  project,
  pullRequest,
}: {
  file: ProjectRepoDiffFile;
  project: Project;
  pullRequest: ProjectPullRequest;
}) {
  const [viewing, setViewing] = React.useState(false);
  const cloneUrl = pullRequest.cloneUrls[0] ?? project.cloneUrls[0];
  if (!cloneUrl || !isHtmlFilename(file.path) || isDeletedFile(file)) {
    return null;
  }
  const filename = file.path.split("/").pop() ?? file.path;

  return (
    <>
      <button
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-foreground hover:bg-muted"
        data-testid="pull-request-html-view"
        onClick={() => setViewing(true)}
        type="button"
      >
        <Eye className="h-3.5 w-3.5" />
        View
      </button>
      {viewing ? (
        <HtmlReportDialog
          filename={filename}
          load={async () => {
            const html = await getProjectRepoFileContent({
              cloneUrl,
              defaultBranch: project.defaultBranch,
              maxBytes: MAX_RENDER_BYTES,
              path: file.path,
              targetCommit: pullRequest.commit ?? null,
              targetRef: `refs/nostr/${pullRequest.id}`,
            });
            if (html == null) {
              throw new Error("the file is not text or is larger than 8 MB");
            }
            return html;
          }}
          loadKey={`${pullRequest.id}:${pullRequest.commit}:${file.path}`}
          onClose={() => setViewing(false)}
        />
      ) : null}
    </>
  );
}
