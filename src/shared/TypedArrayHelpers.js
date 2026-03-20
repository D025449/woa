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

    static getFitLayout(recCount, intervalCount) {
        return [
//            { type: Int32Array, length: 7 },  //bases for delta
            { type: Uint16Array, length: recCount }, //dxPw
            { type: Uint8Array, length: recCount }, // hr
            { type: Uint8Array, length: recCount },// cad
            { type: Uint16Array, length: recCount }, //sp
            { type: Int16Array, length: recCount }, // alt
            { type: Int32Array, length: recCount }, // lat
            { type: Int32Array, length: recCount }, //long
            { type: Uint16Array, length: intervalCount },//start
            { type: Uint16Array, length: intervalCount },//end
            { type: Uint16Array, length: intervalCount },//duration
            { type: Uint16Array, length: intervalCount },//avgPW
            { type: Uint8Array, length: intervalCount },//avgHR
            { type: Uint16Array, length: intervalCount }//avgSpeed * 10

        ];
    }



    static computeSizeForFitRecords(recCount,intervalCount, offSetAfterHeader = 12) {

        const layout = TypedArrayHelpers.getFitLayout(recCount,intervalCount); 

        const size = TypedArrayHelpers.computeSize(layout, offSetAfterHeader);

        //console.log(size);

        return size;

    }

    static allocateViews(buffer, recCount,intervallCount, offSetAfterHeader = 12) {
        const layout = TypedArrayHelpers.getFitLayout(recCount,intervallCount);
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