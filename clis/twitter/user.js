import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { resolveTwitterQueryId } from './shared.js';

const BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const USER_BY_SCREEN_NAME_QUERY_ID = 'qRednkZG-rn1P6b48NINmQ';
const USER_TWEETS_QUERY_ID = 'V7H0Ap3_Hh2FyS75OCDO3Q';
const FEATURES = {
    rweb_video_screen_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    longform_notetweets_consumption_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    freedom_of_speech_not_reach_fetch_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
};

function buildUserTweetsUrl(queryId, userId, count, cursor) {
    const vars = {
        userId,
        count,
        includePromotedContent: false,
        withQuickPromoteEligibilityTweetFields: true,
        withVoice: true,
        withV2Timeline: true,
    };
    if (cursor) vars.cursor = cursor;
    return `/i/api/graphql/${queryId}/UserTweets`
        + `?variables=${encodeURIComponent(JSON.stringify(vars))}`
        + `&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;
}

function extractTweet(r, seen) {
    if (!r) return null;
    const tw = r.tweet || r;
    const l = tw.legacy || {};
    if (!tw.rest_id || seen.has(tw.rest_id)) return null;
    // Skip retweets
    if (l.retweeted_status_id_str) return null;
    seen.add(tw.rest_id);
    const u = tw.core?.user_results?.result;
    const noteText = tw.note_tweet?.note_tweet_results?.result?.text;
    const screenName = u?.legacy?.screen_name || u?.core?.screen_name || 'unknown';
    const views = tw.views?.count ? parseInt(tw.views.count, 10) : 0;
    return {
        index: 0, // filled after collection
        id: tw.rest_id,
        text: (noteText || l.full_text || '').replace(/\n/g, ' ').substring(0, 120),
        likes: l.favorite_count || 0,
        retweets: l.retweet_count || 0,
        replies: l.reply_count || 0,
        views,
        created_at: l.created_at || '',
        url: `https://x.com/${screenName}/status/${tw.rest_id}`,
    };
}

function parseUserTweets(data, seen) {
    const tweets = [];
    let nextCursor = null;
    const instructions = data?.data?.user?.result?.timeline_v2?.timeline?.instructions || [];
    for (const inst of instructions) {
        for (const entry of inst.entries || []) {
            const c = entry.content;
            if (c?.entryType === 'TimelineTimelineCursor' || c?.__typename === 'TimelineTimelineCursor') {
                if (c.cursorType === 'Bottom') nextCursor = c.value;
                continue;
            }
            if (entry.entryId?.startsWith('cursor-bottom-')) {
                nextCursor = c?.value || nextCursor;
                continue;
            }
            const tw = extractTweet(c?.itemContent?.tweet_results?.result, seen);
            if (tw) tweets.push(tw);
            for (const item of c?.items || []) {
                const nested = extractTweet(item.item?.itemContent?.tweet_results?.result, seen);
                if (nested) tweets.push(nested);
            }
        }
    }
    return { tweets, nextCursor };
}

cli({
    site: 'twitter',
    name: 'user',
    description: 'Get recent tweets from a Twitter user',
    domain: 'x.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'username', positional: true, type: 'string', required: true, help: 'Twitter screen name (without @)' },
        { name: 'limit', type: 'int', default: 20, help: 'Number of tweets to return' },
    ],
    columns: ['index', 'id', 'text', 'likes', 'retweets', 'replies', 'views', 'created_at', 'url'],
    func: async (page, kwargs) => {
        const username = kwargs.username.replace(/^@/, '');
        const limit = kwargs.limit || 20;

        await page.goto(`https://x.com/${username}`);
        await page.wait(3);

        const ct0 = await page.evaluate(`() => {
            return document.cookie.split(';').map(c=>c.trim()).find(c=>c.startsWith('ct0='))?.split('=')[1] || null;
        }`);
        if (!ct0) throw new AuthRequiredError('x.com', 'Not logged into x.com (no ct0 cookie)');

        const headers = JSON.stringify({
            'Authorization': `Bearer ${decodeURIComponent(BEARER_TOKEN)}`,
            'X-Csrf-Token': ct0,
            'X-Twitter-Auth-Type': 'OAuth2Session',
            'X-Twitter-Active-User': 'yes',
        });

        // Step 1: resolve userId via UserByScreenName
        const userQueryId = await resolveTwitterQueryId(page, 'UserByScreenName', USER_BY_SCREEN_NAME_QUERY_ID);
        const userVars = encodeURIComponent(JSON.stringify({ screen_name: username, withSafetyModeUserFields: true }));
        const userFeatures = encodeURIComponent(JSON.stringify({
            hidden_profile_subscriptions_enabled: true,
            responsive_web_graphql_exclude_directive_enabled: true,
            verified_phone_label_enabled: false,
            responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
            responsive_web_graphql_timeline_navigation_enabled: true,
        }));
        const userUrl = `/i/api/graphql/${userQueryId}/UserByScreenName?variables=${userVars}&features=${userFeatures}`;

        const userData = await page.evaluate(`async () => {
            const r = await fetch("${userUrl}", { headers: ${headers}, credentials: 'include' });
            return r.ok ? await r.json() : { error: r.status };
        }`);
        if (userData?.error) throw new CommandExecutionError(`HTTP ${userData.error}: Could not resolve user @${username}`);
        const userId = userData?.data?.user?.result?.rest_id;
        if (!userId) throw new CommandExecutionError(`User @${username} not found`);

        // Step 2: fetch UserTweets
        const tweetsQueryId = await resolveTwitterQueryId(page, 'UserTweets', USER_TWEETS_QUERY_ID);
        const allTweets = [];
        const seen = new Set();
        let cursor = null;

        for (let i = 0; i < 5 && allTweets.length < limit; i++) {
            const apiUrl = buildUserTweetsUrl(tweetsQueryId, userId, Math.min(40, limit + 5), cursor);
            const data = await page.evaluate(`async () => {
                const r = await fetch("${apiUrl}", { headers: ${headers}, credentials: 'include' });
                return r.ok ? await r.json() : { error: r.status };
            }`);
            if (data?.error) {
                if (allTweets.length === 0)
                    throw new CommandExecutionError(`HTTP ${data.error}: Failed to fetch tweets. queryId may have expired.`);
                break;
            }
            const { tweets, nextCursor } = parseUserTweets(data, seen);
            allTweets.push(...tweets);
            if (!nextCursor || nextCursor === cursor) break;
            cursor = nextCursor;
        }

        return allTweets.slice(0, limit).map((t, i) => ({ ...t, index: i + 1 }));
    },
});
