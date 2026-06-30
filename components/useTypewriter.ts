import { useState, useEffect, useRef } from 'react';

/**
 * A high-performance typewriter effect hook that supports fast chunk-based text typing.
 * It only animates when `active` is true. If `active` is false, it returns the full text instantly.
 * 
 * @param text The full text to type out.
 * @param active Whether the typewriter effect should be active.
 * @param speed The interval in milliseconds between typing ticks.
 * @param chunkSize The number of characters to append on each tick.
 */
export const useTypewriter = (text: string, active: boolean, speed = 8, chunkSize = 6) => {
    const [displayedText, setDisplayedText] = useState(active ? '' : text);
    const indexRef = useRef(active ? 0 : text.length);
    const textRef = useRef(text);
    textRef.current = text;

    useEffect(() => {
        if (!active) {
            setDisplayedText(text);
            return;
        }

        // Initialize / Reset
        setDisplayedText('');
        indexRef.current = 0;

        const timer = setInterval(() => {
            if (indexRef.current < textRef.current.length) {
                const nextIndex = Math.min(indexRef.current + chunkSize, textRef.current.length);
                setDisplayedText(textRef.current.slice(0, nextIndex));
                indexRef.current = nextIndex;
            } else {
                clearInterval(timer);
            }
        }, speed);

        return () => clearInterval(timer);
    }, [text, active, speed, chunkSize]);

    return displayedText;
};
