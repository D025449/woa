export default class Utils {

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

        return `${Utils.formatDuration(seg.duration)}\n${seg.avg_power}W\n${seg.avg_heart_rate}bpm\n${seg.avg_speed}km/h`
    }

}

