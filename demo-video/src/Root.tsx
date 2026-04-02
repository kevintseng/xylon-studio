import React from "react";
import { Composition } from "remotion";
import { XylonStudioDemo } from "./XylonStudioDemo";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="XylonStudioDemo"
      component={XylonStudioDemo}
      durationInFrames={600}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
