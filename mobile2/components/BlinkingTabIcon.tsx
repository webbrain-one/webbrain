import FontAwesome from '@expo/vector-icons/FontAwesome';
import React, { useEffect, useRef } from 'react';
import { Animated } from 'react-native';

type Props = {
  name: React.ComponentProps<typeof FontAwesome>['name'];
  color: string;
  blink: boolean;
};

/**
 * Tab-bar icon that pulses opacity while `blink` is true. Used on the Browser
 * tab so the user gets a visual signal that the agent is acting on the page
 * even when they're looking at the Chat tab.
 */
export default function BlinkingTabIcon({ name, color, blink }: Props) {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!blink) {
      opacity.stopAnimation();
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.25,
          duration: 500,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 500,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      opacity.setValue(1);
    };
  }, [blink, opacity]);

  return (
    <Animated.View style={{ opacity, marginBottom: -3 }}>
      <FontAwesome size={28} name={name} color={color} />
    </Animated.View>
  );
}
