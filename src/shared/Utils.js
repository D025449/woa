export default class Utils {

    static getSegmentDisplayTitle(seg) {
        return seg.segmentname?.trim()
            || (seg.isGPSSegment ? "GPS Segment" : `${seg.segmenttype ?? "Segment"} Segment`);
    }

    static formatDuration(seconds) {
        if (seconds == null) return "";

        const total = Math.floor(seconds);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;

        if (seconds < 60)
        {
            return `${seconds.toFixed(1)} s`;
        }


        if (h > 0) {
            return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        }

        return `${m}:${String(s).padStart(2, "0")}`;
    }

    static formatStartIndex( startindex ){
        if (startindex == null) return "";

        const total = Math.floor(startindex);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;

        if (h > 0) {
            return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        }

        return `${m}:${String(s).padStart(2, "0")}`;        
    }

    static formatSeconds(value) {
        const total = Math.round(value);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;

        return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }

    static formatSegment(seg){
        return Utils.formatSegmentLabel(seg);
    }

    static formatSegmentLabel(seg) {
        const title = Utils.getSegmentDisplayTitle(seg);

        if (!seg.duration) {
            return title;
        }

        return `${title}\n${Utils.formatDuration(seg.duration)}`;
    }

    static formatSegmentTooltip(seg) {
        const title = Utils.getSegmentDisplayTitle(seg);
        const secondaryValue = Number.isFinite(seg.avg_power)
            ? `${Math.round(seg.avg_power)} W`
            : Number.isFinite(seg.avg_speed)
                ? `${Number(seg.avg_speed).toFixed(1)} km/h`
                : "–";

        const rows = [
            [`Typ`, seg.isGPSSegment ? "GPS Segment" : (seg.segmenttype ?? "manual")],
            [`Dauer`, Utils.formatDuration(seg.duration)],
            [`Leistung`, Number.isFinite(seg.avg_power) ? `${Math.round(seg.avg_power)} W` : "–"],
            [`Herzfrequenz`, Number.isFinite(seg.avg_heart_rate) ? `${Math.round(seg.avg_heart_rate)} bpm` : "–"],
            [`Kadenz`, Number.isFinite(seg.avg_cadence) ? `${Math.round(seg.avg_cadence)} rpm` : "–"],
            [`Speed`, Number.isFinite(seg.avg_speed) ? `${Number(seg.avg_speed).toFixed(1)} km/h` : "–"]
        ];

        return `
            <div style="min-width: 220px;">
                <div style="font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #94a3b8; margin-bottom: 4px;">Segment</div>
                <div style="font-size: 14px; font-weight: 700; color: #0f172a; margin-bottom: 2px;">${title}</div>
                <div style="font-size: 12px; font-weight: 600; color: #334155; margin-bottom: 8px;">${Utils.formatDuration(seg.duration)} · ${secondaryValue}</div>
                ${rows.map(([label, value]) => `
                    <div style="display:flex; justify-content:space-between; gap:12px; margin:2px 0;">
                        <span style="color:#64748b;">${label}</span>
                        <span style="font-weight:600; color:#0f172a;">${value}</span>
                    </div>
                `).join("")}
            </div>
        `;
    }

}
