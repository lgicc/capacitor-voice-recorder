import { WebPlugin } from '@capacitor/core';
import type { IMediaRecorder} from 'extendable-media-recorder';
import {deregister, MediaRecorder, register} from 'extendable-media-recorder';
import {connect, disconnect} from 'extendable-media-recorder-wav-encoder';

import type { CanRecordStatus, CapacitorVoiceRecorderPlugin, RecordingData, RecordStatus } from './definitions';
import { RecordingError } from './definitions';

export class CapacitorVoiceRecorderWeb extends WebPlugin implements CapacitorVoiceRecorderPlugin {
  private _mediaRecorder?: IMediaRecorder;
  private _mediaStream?: MediaStream;
  mimeType: string = 'audio/wav' as const;
  private _chunks: any[] = [];
  private _startedRecordingAt?: Date;
  private _encoder: any;

  constructor() {
    super();
  }

  public async canRecord(): Promise<{ status: CanRecordStatus }> {
    if (!navigator.mediaDevices?.getUserMedia) {
      return Promise.reject(RecordingError.DEVICE_NOT_SUPPORTED);
    }

    return navigator.permissions.query({ name: 'microphone' as any }).then((result) => {
      if (result.state === 'granted') {
        return { status: 'GRANTED' };
      } else {
        return { status: 'NOT_GRANTED' };
      }
    });
  }

  public async requestPermission(): Promise<{ isGranted: true }> {
    if (!navigator.mediaDevices?.getUserMedia) {
      return Promise.reject(RecordingError.DEVICE_NOT_SUPPORTED);
    }

    const hasPermission = await this.canRecord();

    if (hasPermission.status === 'GRANTED') {
      return { isGranted: true };
    }

    try {
      return navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        stream.getTracks().forEach((track) => track.stop());
        return { isGranted: true };
      });
    } catch (error) {
      return Promise.reject(RecordingError.MISSING_MICROPHONE_PERMISSION);
    }
  }

  public async startRecording(): Promise<void> {
    if (this._mediaRecorder != null) {
      return Promise.reject(RecordingError.MICROPHONE_IN_USE);
    }

    const hasPermission = await this.canRecord();

    if (hasPermission.status !== 'GRANTED') {
      return Promise.reject(RecordingError.MISSING_MICROPHONE_PERMISSION);
    }

    this._encoder = await connect();
    await register(this._encoder);

    this._mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this._mediaRecorder = new MediaRecorder(this._mediaStream, { mimeType: 'audio/wav' });

    this._mediaRecorder.onstart = () => {
      this._startedRecordingAt = new Date();
    };
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 8192;
    analyser.minDecibels = -90;
    analyser.maxDecibels = -10;
    analyser.smoothingTimeConstant = 0;

    const dataArray = new Uint8Array(analyser.fftSize);
    const source = audioContext.createMediaStreamSource(this._mediaStream);
    source.connect(analyser);

    this._mediaRecorder.ondataavailable = async (event: any) => {
      this._chunks.push(event.data);

      analyser.getByteFrequencyData(dataArray);
      const frequencies = btoa(String.fromCharCode.apply(null, Array.from(dataArray).splice(0, analyser.fftSize)));
      this.notifyListeners('frequencyData', { base64: frequencies });
    };

    this._mediaRecorder.onerror = () => {
      if (!this._mediaRecorder) {
        return Promise.reject(RecordingError.NOT_RECORDING);
      }

      this._mediaRecorder.stop();
      this._prepareInstanceForNextOperation();

      this._startedRecordingAt = undefined;
      this._mediaStream = undefined;
      this._mediaRecorder = undefined;
      this._chunks = [];
      return Promise.reject(RecordingError.UNKNOWN_ERROR);
    };

    this._mediaRecorder.start(100);
  }

  public async stopRecording(): Promise<RecordingData> {
    if (!this._mediaRecorder) {
      return Promise.reject(RecordingError.NOT_RECORDING);
    }

    const mimeType = this.mimeType;

    if (mimeType == null) {
      return Promise.reject(RecordingError.DEVICE_NOT_SUPPORTED);
    }

    this._prepareInstanceForNextOperation();

    const blobVoiceRecording = new Blob(this._chunks, { type: mimeType });

    const recordingDuration = new Date().getTime() - this._startedRecordingAt!.getTime();

    this._startedRecordingAt = undefined;
    this._mediaStream = undefined;
    this._mediaRecorder = undefined;
    this._chunks = [];
    await deregister(this._encoder);
    await disconnect(this._encoder);
    this._encoder = undefined;

    return {
      base64: await this._blobToBase64(blobVoiceRecording),
      msDuration: recordingDuration,
      size: blobVoiceRecording.size,
    };
  }

  public async pauseRecording(): Promise<void> {
    if (!this._mediaRecorder) {
      return Promise.reject(RecordingError.NOT_RECORDING);
    }

    if (this._mediaRecorder.state === 'recording') {
      this._mediaRecorder.pause();
      return;
    }

    return Promise.reject(RecordingError.NOT_RECORDING);
  }

  public async resumeRecording(): Promise<void> {
    if (!this._mediaRecorder) {
      return Promise.reject(RecordingError.NOT_RECORDING);
    }

    if (this._mediaRecorder.state === 'paused') {
      this._mediaRecorder.resume();
      return;
    }

    return Promise.reject(RecordingError.NOT_RECORDING);
  }

  public async getCurrentStatus(): Promise<{ status: RecordStatus }> {
    if (!this._mediaRecorder) {
      return Promise.resolve({ status: 'NOT_RECORDING' });
    }

    if (this._mediaRecorder.state === 'recording') {
      return Promise.resolve({ status: 'RECORDING' });
    } else if (this._mediaRecorder.state === 'paused') {
      return Promise.resolve({ status: 'PAUSED' });
    } else {
      return Promise.resolve({ status: 'NOT_RECORDING' });
    }
  }

  private _prepareInstanceForNextOperation(): void {
    if (this._mediaRecorder != null && this._mediaRecorder.state !== 'inactive') {
      try {
        this._mediaRecorder.stop();
        this._mediaStream!.getTracks().forEach((track) => track.stop());
      } catch (error) {
        console.warn('While trying to stop a media recorder, an error was thrown', error);
      }
    }
  }

  private async _blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64Data = dataUrl.split(',')[1]; // Extract base64 part
        resolve(base64Data);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}
