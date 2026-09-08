import * as React from "react";

import type {
  ProjectIssue,
  ProjectPullRequest,
  Repository,
} from "@/features/projects/hooks";
import {
  projectContributorActivityCounts,
  signedProjectContributorPubkeys,
  type ViewerGitIdentity,
} from "@/features/projects/lib/projectContributorMatching";
import { useGitIdentityQuery } from "@/features/projects/useGitIdentity";
import { useProfileQuery, useUsersBatchQuery } from "@/features/profile/hooks";
import { mergeCurrentProfileIntoLookup } from "@/features/profile/lib/identity";
import { useIdentityQuery } from "@/shared/api/hooks";
import { projectPeople } from "./projectDetailHelpers";

/** Resolves profiles and contributor identity data used across project panels. */
export function useProjectDetailPeople({
  issues,
  pullRequests,
  repositories,
  repository,
}: {
  issues: ProjectIssue[];
  pullRequests: ProjectPullRequest[];
  /**
   * Every repository whose owner and declared contributors count as people
   * here. Defaults to `repository` alone, which is what a single-repository
   * surface wants; the project home passes all of them so the tab is not
   * silently scoped to one.
   */
  repositories?: Repository[];
  repository: Repository | null;
}) {
  const scopedRepositories = React.useMemo(
    () => repositories ?? (repository ? [repository] : []),
    [repositories, repository],
  );
  // `owner` only seeds the key set, so folding every repository's owner in
  // alongside its contributors is equivalent to naming each one as an owner.
  const scopedContributors = React.useMemo(
    () =>
      scopedRepositories.flatMap((scoped) => [
        scoped.owner,
        ...scoped.contributors,
      ]),
    [scopedRepositories],
  );
  const peoplePubkeys = React.useMemo(() => {
    if (!repository) return [];
    const pullRequestPubkeys = pullRequests.flatMap((pullRequest) => [
      pullRequest.author,
      ...pullRequest.updates.map((update) => update.author),
      ...pullRequest.comments.map((comment) => comment.author),
      ...pullRequest.reviewers,
      ...pullRequest.approvals.map((approval) => approval.author),
    ]);
    const issuePubkeys = issues.flatMap((issue) => [
      issue.author,
      ...issue.recipients,
      ...issue.assignees,
      ...issue.comments.map((comment) => comment.author),
    ]);
    return [
      ...new Set([
        ...scopedRepositories.flatMap(projectPeople),
        ...pullRequestPubkeys,
        ...issuePubkeys,
      ]),
    ];
  }, [issues, pullRequests, repository, scopedRepositories]);
  const profilesQuery = useUsersBatchQuery(peoplePubkeys, {
    enabled: peoplePubkeys.length > 0,
  });
  const currentProfileQuery = useProfileQuery();
  const profiles = React.useMemo(
    () =>
      mergeCurrentProfileIntoLookup(
        profilesQuery.data?.profiles,
        currentProfileQuery.data,
      ),
    [currentProfileQuery.data, profilesQuery.data?.profiles],
  );
  const contributorPubkeys = React.useMemo(() => {
    if (!repository) return [];
    return signedProjectContributorPubkeys({
      contributors: scopedContributors,
      issues,
      owner: repository.owner,
      pullRequests,
    });
  }, [issues, pullRequests, repository, scopedContributors]);
  const contributorActivityCounts = React.useMemo(() => {
    if (!repository) return {};
    return projectContributorActivityCounts({
      contributors: scopedContributors,
      issues,
      owner: repository.owner,
      pullRequests,
    });
  }, [issues, pullRequests, repository, scopedContributors]);
  const identityQuery = useIdentityQuery();
  const gitIdentityQuery = useGitIdentityQuery();
  const viewerGitIdentity = React.useMemo<ViewerGitIdentity | null>(() => {
    const pubkey = identityQuery.data?.pubkey ?? null;
    if (!pubkey || !gitIdentityQuery.data) return null;
    return {
      pubkey,
      name: gitIdentityQuery.data.name,
      email: gitIdentityQuery.data.email,
    };
  }, [gitIdentityQuery.data, identityQuery.data?.pubkey]);

  return {
    contributorActivityCounts,
    contributorPubkeys,
    identityPubkey: identityQuery.data?.pubkey,
    profiles,
    viewerGitIdentity,
  };
}
