DROP TABLE IF EXISTS gps_segment_best_efforts;

CREATE TABLE gps_segment_best_efforts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    segment_id      UUID NOT NULL,
    file_id         UUID    NOT NULL,
    auth_sub        TEXT   NOT NULL,
    start_offset    INTEGER NOT NULL,
    end_offset      INTEGER NOT NULL,
    duration        INTEGER NOT NULL,
    avg_power       DOUBLE PRECISION NOT NULL,
    avg_heart_rate  DOUBLE PRECISION,
    avg_cadence     DOUBLE PRECISION,
    avg_speed       DOUBLE PRECISION,  
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT fk_gps_segments
        FOREIGN KEY (segment_id)
        REFERENCES gps_segments(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_file
        FOREIGN KEY (file_id)
        REFERENCES files(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_user
        FOREIGN KEY (auth_sub)
        REFERENCES users(auth_sub)
        ON DELETE CASCADE


);


CREATE TRIGGER trigger_set_updated_at
BEFORE UPDATE ON gps_segment_best_efforts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
