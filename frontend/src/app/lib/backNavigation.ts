export function getBackFallbackHref(pathname: string): string | null {
    if (/^\/assistant\/chat\/[^/]+\/?$/.test(pathname)) {
        return "/assistant";
    }

    const projectAssistantChat = pathname.match(
        /^\/projects\/([^/]+)\/assistant\/chat\/[^/]+\/?$/,
    );
    if (projectAssistantChat) {
        return `/projects/${projectAssistantChat[1]}/doc-review`;
    }

    const projectDocReviewChat = pathname.match(
        /^\/projects\/([^/]+)\/doc-review\/chat\/[^/]+\/?$/,
    );
    if (projectDocReviewChat) {
        return `/projects/${projectDocReviewChat[1]}/doc-review`;
    }

    const projectTabularReview = pathname.match(
        /^\/projects\/([^/]+)\/tabular-reviews\/[^/]+\/?$/,
    );
    if (projectTabularReview) {
        return `/projects/${projectTabularReview[1]}/tabular-reviews`;
    }

    const projectSection = pathname.match(
        /^\/projects\/([^/]+)\/(?:doc-review|tabular-reviews|workspace)\/?$/,
    );
    if (projectSection) {
        return `/projects/${projectSection[1]}`;
    }

    const projectRoot = pathname.match(/^\/projects\/([^/]+)\/?$/);
    if (projectRoot) {
        return "/projects";
    }

    if (/^\/tabular-reviews\/[^/]+\/?$/.test(pathname)) {
        return "/tabular-reviews";
    }

    if (/^\/workflows\/[^/]+\/?$/.test(pathname)) {
        return "/workflows";
    }

    if (/^\/account\/.+/.test(pathname)) {
        return "/account";
    }

    return null;
}
