export class TypedArrayHelpers {
    static align(offset, alignment) {
        if ((alignment & (alignment - 1)) !== 0) {
            throw new Error("alignment must be a power of two");
        }
        return (offset + alignment - 1) & ~(alignment - 1);
    }

    static computeSize(layout, firstOffset = 0) {
        let offset = firstOffset;

        for (const { type, length } of layout) {
            const alignBytes = type.BYTES_PER_ELEMENT;
            offset = TypedArrayHelpers.align(offset, alignBytes);
            offset += length * type.BYTES_PER_ELEMENT;
        }

        return offset;
    }

    static getFitLayout(recCount) {
        return [
            { type: Int32Array, length: 7 },
            { type: Int16Array, length: recCount },
            { type: Int8Array, length: recCount },
            { type: Int8Array, length: recCount },
            { type: Int8Array, length: recCount },
            { type: Int8Array, length: recCount },
            { type: Int32Array, length: recCount },
            { type: Int32Array, length: recCount }
        ];
    }



    static computeSizeForFitRecords(recCount, offSetAfterHeader = 12) {

        const layout = TypedArrayHelpers.getFitLayout(recCount); 

        const size = TypedArrayHelpers.computeSize(layout, offSetAfterHeader);

        console.log(size);

        return size;

    }

    static allocateViews(buffer, recCount, offSetAfterHeader = 12) {
        const layout = TypedArrayHelpers.getFitLayout(recCount);
        let offset = offSetAfterHeader;
        const views = [];

        for (const { type, length } of layout) {
            const alignBytes = type.BYTES_PER_ELEMENT;
            offset = TypedArrayHelpers.align(offset, alignBytes);

            const view = new type(buffer, offset, length);
            views.push(view);

            offset += view.byteLength;
        }

        return views;
    }


}