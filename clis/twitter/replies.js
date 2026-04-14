import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { resolveTwitterQueryId } from './shared.js';

const BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const TWEET_DETAIL_QUERY_ID = 'nBS-WpgA6ZG0CyNHD517JQ';
const FEATURES = {
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    longform_notetweets_consumption_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    freedom_of_speech_not_reach_fetch_enabled: true,
};
const FIELD_TOGGLES = { withArticleRichContentState: true, withArticlePlainText: false };

function buildTweetDetailUrl(queryId, tweetId, cursor) {
    const vars = {
        focalTweetId: tweetId,
        referrer: 'tweet',
        with_rux_injections: false,
        includePromotedContent: false,
        rankingMode: 'Recency',
        withCommunity: true,
        withQuickPromoteEligibilityTweetFields: true,
        withBirdwatchNotes: true,
        withVoice: true,
    };
    if (cursor) vars.cursor = cursor;
    return `/i/api/graphql/${queryId}/TweetDetail`
        + `?variables=${encodeURIComponent(JSON.stringify(vars))}`
        + `&features=${encodeURIComponent(JSON.stringify(FEATURES))}`
        + `&fieldToggles=${encodeURIComponent(JSON.stringify(FIELD_TOGGLES))}`;
}

function extractTweet(r, seen) {
    if (!r) return null;
    const tw = r.tweet || r;
    const l = tw.legacy || {};
    if (!tw.rest_id || seen.has(tw.rest_id)) return null;
    seen.add(tw.rest_id);
    const u = tw.core?.user_results?.result;
    const noteText = tw.note_tweet?.note_tweet_results?.result?.text;
    const screenName = u?.legacy?.screen_name || u?.core?.screen_name || 'unknown';
    return {
        id: tw.rest_id,
        author: screenName,
        text: noteText || l.full_text || '',
        likes: l.favorite_count || 0,
        retweets: l.retweet_count || 0,
        replies: l.reply_count || 0,
        in_reply_to: l.in_reply_to_status_id_str || null,
        created_at: l.created_at || '',
        url: `https://x.com/${screenName}/status/${tw.rest_id}`,
    };
}

function parseTweetDetail(data, focalTweetId, seen) {
    const tweets = [];
    let nextCursor = null;
    const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions || [];
    for (const inst of instructions) {
        for (const entry of inst.entries || []) {
            const c = entry.content;
            if (c?.entryType === 'TimelineTimelineCursor' || c?.__typename === 'TimelineTimelineCursor') {
                if (c.cursorType === 'Bottom' || c.cursorType === 'ShowMore') nextCursor = c.value;
                continue;
            }
            if (entry.entryId?.startsWith('cursor-bottom-') || entry.entryId?.startsWith('cursor-showMore-')) {
                nextCursor = c?.itemContent?.value || c?.value || nextCursor;
                continue;
            }
            const tw = extractTweet(c?.itemContent?.tweet_results?.result, seen);
            if (tw && tw.id !== focalTweetId) tweets.push(tw);
            for (const item of c?.items || []) {
                const nested = extractTweet(item.item?.itemContent?.tweet_results?.result, seen);
                if (nested && nested.id !== focalTweetId) tweets.push(nested);
            }
        }
    }
    return { tweets, nextCursor };
}

cli({
    site: 'twitter',
    name: 'replies',
    description: 'Get replies to a specific tweet',
    domain: 'x.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'tweet-id', positional: true, type: 'string', required: true, help: 'Tweet URL or ID' },
        { name: 'limit', type: 'int', default: 50, help: 'Max number of replies to return' },
    ],
    columns: ['id', 'author', 'text', 'likes', 'retweets', 'replies', 'created_at', 'url'],
    func: async (page, kwargs) => {
        let tweetId = kwargs['tweet-id'];
        const urlMatch = tweetId.match(/\/status\/(\d+)/);
        if (urlMatch) tweetId = urlMatch[1];

        await page.goto('https://x.com');
        await page.wait(3);

        const ct0 = await page.evaluate(`() => {
            return document.cookie.split(';').map(c=>c.trim()).find(c=>c.startsWith('ct0='))?.split('=')[1] || null;
        }`);
        if (!ct0) throw new AuthRequiredError('x.com', 'Not logged into x.com (no ct0 cookie)');

        const queryId = await resolveTwitterQueryId(page, 'TweetDetail', TWEET_DETAIL_QUERY_ID);
        const headers = JSON.stringify({
            'Authorization': `Bearer ${decodeURIComponent(BEARER_TOKEN)}`,
            'X-Csrf-Token': ct0,
            'X-Twitter-Auth-Type': 'OAuth2Session',
            'X-Twitter-Active-User': 'yes',
        });

        const allReplies = [];
        const seen = new Set();
        let cursor = null;

        for (let i = 0; i < 5 && allReplies.length < kwargs.limit; i++) {
            const apiUrl = buildTweetDetailUrl(queryId, tweetId, cursor);
            const data = await page.evaluate(`async () => {
                const r = await fetch("${apiUrl}", { headers: ${headers}, credentials: 'include' });
                return r.ok ? await r.json() : { error: r.status };
            }`);
            if (data?.error) {
                if (allReplies.length === 0)
                    throw new CommandExecutionError(`HTTP ${data.error}: Tweet not found or queryId expired`);
                break;
            }
            const { tweets, nextCursor } = parseTweetDetail(data, tweetId, seen);
            allReplies.push(...tweets);
            if (!nextCursor || nextCursor === cursor) break;
            cursor = nextCursor;
        }

        return allReplies.slice(0, kwargs.limit);
    },
});
