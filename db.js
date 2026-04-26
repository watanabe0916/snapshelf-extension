/* global Dexie */

const snapShelfDB = new Dexie('SnapShelfDB');

snapShelfDB.version(1).stores({
    screenshots: '++id, groupId, imageBlob, pageUrl, timestamp',
});

async function addScreenshot(record) {
    return snapShelfDB.table('screenshots').add(record);
}

async function getScreenshotsByGroup(groupId) {
    const rows = await snapShelfDB.table('screenshots').where('groupId').equals(groupId).toArray();
    return rows.sort((a, b) => b.timestamp - a.timestamp);
}

async function deleteScreenshotById(id) {
    return snapShelfDB.table('screenshots').delete(id);
}

async function deleteScreenshotsByGroup(groupId) {
    return snapShelfDB.table('screenshots').where('groupId').equals(groupId).delete();
}

async function getScreenshotCountsByGroupIds(groupIds) {
    const counts = {};
    if (!Array.isArray(groupIds) || groupIds.length === 0) {
        return counts;
    }

    const rows = await snapShelfDB.table('screenshots').where('groupId').anyOf(groupIds).toArray();
    rows.forEach((row) => {
        const groupId = row.groupId;
        counts[groupId] = (counts[groupId] || 0) + 1;
    });

    return counts;
}

self.SnapShelfDB = {
    db: snapShelfDB,
    addScreenshot,
    getScreenshotsByGroup,
    deleteScreenshotById,
    deleteScreenshotsByGroup,
    getScreenshotCountsByGroupIds,
};