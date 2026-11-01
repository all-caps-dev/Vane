import configManager from '@/lib/config';
import ModelRegistry from '@/lib/models/registry';
import { NextRequest, NextResponse } from 'next/server';
import { ConfigModelProvider, UIConfigSections } from '@/lib/config/types';
import { internalModelOptions } from '@/lib/models/internalModel';

type SaveConfigBody = {
  key: string;
  value: string | boolean;
};

export const GET = async (req: NextRequest) => {
  try {
    const values = configManager.getCurrentConfig();
    // A copy, because the internal model's options are filled per request.
    const fields: UIConfigSections = structuredClone(
      configManager.getUIConfigSections(),
    );

    const modelRegistry = new ModelRegistry();
    const modelProviders = await modelRegistry.getActiveProviders();

    values.modelProviders = values.modelProviders.map(
      (mp: ConfigModelProvider) => {
        const activeProvider = modelProviders.find((p) => p.id === mp.id);

        return {
          ...mp,
          chatModels: activeProvider?.chatModels ?? mp.chatModels,
          embeddingModels:
            activeProvider?.embeddingModels ?? mp.embeddingModels,
        };
      },
    );

    /* The internal model select lists every chat model configured right
       now, as providerId:key (the same list /api/providers returns). */
    fields.search = fields.search.map((f) =>
      f.key === 'internalModel' && f.type === 'select'
        ? {
            ...f,
            options: internalModelOptions(
              modelProviders,
              values.search?.internalModel,
            ),
          }
        : f,
    );

    return NextResponse.json({
      values,
      fields,
    });
  } catch (err) {
    console.error('Error in getting config: ', err);
    return Response.json(
      { message: 'An error has occurred.' },
      { status: 500 },
    );
  }
};

export const POST = async (req: NextRequest) => {
  try {
    const body: SaveConfigBody = await req.json();

    /* A switch saves the boolean false, which is a real value, not a missing one. */
    if (!body.key || (!body.value && body.value !== false)) {
      return Response.json(
        {
          message: 'Key and value are required.',
        },
        {
          status: 400,
        },
      );
    }

    configManager.updateConfig(body.key, body.value);

    return Response.json(
      {
        message: 'Config updated successfully.',
      },
      {
        status: 200,
      },
    );
  } catch (err) {
    console.error('Error in getting config: ', err);
    return Response.json(
      { message: 'An error has occurred.' },
      { status: 500 },
    );
  }
};
