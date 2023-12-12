import { useState, useRef, useEffect } from "react";
import { useRecoilValue, useSetRecoilState } from "recoil";
import { Socket, Manager } from "socket.io-client";
import { useNavigate, useLocation } from "react-router-dom";
import axios from "axios";

import VolumeMeter from "./VolumeMeter";
import PlayIcon from "@/assets/svgs/play.svg?react";
import StopIcon from "@/assets/svgs/stop.svg?react";
import MicOnIcon from "@/assets/svgs/micOn.svg?react";
import MicOffIcon from "@/assets/svgs/micOff.svg?react";
import SmallButton from "@/components/SmallButton/SmallButton";
import Modal from "@/components/Modal/Modal";

import { useToast } from "@/components/Toast/useToast";
import { ICanvasData, saveCanvasData } from "@/utils/fabricCanvasUtil";
import { convertMsTohhmm } from "@/utils/convertMsToTimeString";
import calcNormalizedVolume from "@/utils/calcNormalizedVolume";

import selectedMicrophoneState from "@/stores/stateSelectedMicrophone";
import micVolumeGainState from "@/stores/stateMicVolumeGain";
import micVolumeState from "@/stores/stateMicVolume";
import cavasInstanceState from "@/pages/Test/components/stateCanvasInstance";
import instructorSocketState from "@//stores/stateInstructorSocketRef";

interface HeaderInstructorControlsProps {
  setLectureCode: React.Dispatch<React.SetStateAction<string>>;
}

const HeaderInstructorControls = ({ setLectureCode }: HeaderInstructorControlsProps) => {
  const isLectureStartRef = useRef<boolean>(false);

  const [isMicOn, setIsMicOn] = useState(true);
  const [isStartModalOpen, setIsStartModalOpen] = useState(false);
  const [isCloseModalOpen, setIsCloseModalOpen] = useState(false);
  const [elapsedTime, setElapsedTime] = useState<number>(0);

  const selectedMicrophone = useRecoilValue(selectedMicrophoneState);
  const inputMicVolume = useRecoilValue(micVolumeGainState);
  const fabricCanvasRef = useRecoilValue(cavasInstanceState);
  const setInputMicVolumeState = useSetRecoilState(micVolumeGainState);
  const setMicVolumeState = useSetRecoilState(micVolumeState);
  const setInstructorSocket = useSetRecoilState(instructorSocketState);
  const navigate = useNavigate();
  const showToast = useToast();

  const timerIdRef = useRef<number | null>(null); // 경과 시간 표시 타이머 id
  const onFrameIdRef = useRef<number | null>(null); // 마이크 볼륨 측정 타이머 id
  const managerRef = useRef<Manager>();
  const socketRef = useRef<Socket>();
  const lectureSocketRef = useRef<Socket>();
  const pcRef = useRef<RTCPeerConnection>();
  const mediaStreamRef = useRef<MediaStream>();
  const updatedStreamRef = useRef<MediaStream>();
  const inputMicVolumeRef = useRef<number>(0);
  const prevInputMicVolumeRef = useRef<number>(0);

  const roomid = new URLSearchParams(useLocation().search).get("roomid") || "999999";
  const pc_config = {
    iceServers: [
      {
        urls: ["stun:stun.l.google.com:19302"]
      },
      {
        urls: import.meta.env.VITE_TURN_URL as string,
        username: import.meta.env.VITE_TURN_USERNAME as string,
        credential: import.meta.env.VITE_TURN_PASSWORD as string
      }
    ]
  };

  useEffect(() => {
    axios
      .get(`${import.meta.env.VITE_API_SERVER_URL}/lecture?code=${roomid}`)
      .then((result) => {
        const lecureTitle = result.data.title;
        console.log(lecureTitle);
        // 이후 작업 내일 예정
      })
      .catch(() => {
        // showToast({ message: "존재하지 않는 강의실입니다.", type: "alert" });
        // navigate("/");
      });
    setLectureCode(roomid);
    window.addEventListener("popstate", handlePopstate);
  }, []);
  useEffect(() => {
    inputMicVolumeRef.current = inputMicVolume;
  }, [inputMicVolume]);
  useEffect(() => {
    if (isLectureStartRef.current) {
      replaceAudioTrack();
    }
  }, [selectedMicrophone]);

  const startLecture = async () => {
    if (!selectedMicrophone) {
      showToast({ message: "음성 입력장치(마이크)를 먼저 선택해 주세요.", type: "alert" });
      return;
    }
    setIsStartModalOpen(false);
    await initConnection();
    await createPresenterOffer();
  };

  const stopLecture = () => {
    if (!isLectureStartRef.current) {
      showToast({ message: "강의가 시작되지 않았습니다.", type: "alert" });
      return;
    }
    isLectureStartRef.current = false;
    setElapsedTime(0);

    if (!lectureSocketRef.current) return;
    lectureSocketRef.current.emit("end", {
      type: "lecture",
      roomId: roomid
    });

    if (timerIdRef.current) clearInterval(timerIdRef.current); // 경과 시간 표시 타이머 중지
    if (onFrameIdRef.current) window.cancelAnimationFrame(onFrameIdRef.current); // 마이크 볼륨 측정 중지
    if (socketRef.current) socketRef.current.disconnect(); // 소켓 연결 해제
    if (lectureSocketRef.current) lectureSocketRef.current.disconnect(); // 소켓 연결 해제
    if (pcRef.current) pcRef.current.close(); // RTCPeerConnection 해제
    if (mediaStreamRef.current) mediaStreamRef.current.getTracks().forEach((track) => track.stop()); // 미디어 트랙 중지

    setIsCloseModalOpen(false);
    showToast({ message: "강의가 종료되었습니다.", type: "alert" });
    navigate("/lecture-end");
  };

  const initConnection = async () => {
    try {
      // 0. 소켓 연결
      managerRef.current = new Manager(import.meta.env.VITE_MEDIA_SERVER_URL);
      socketRef.current = managerRef.current.socket("/create-room", {
        auth: {
          accessToken: localStorage.getItem("token"),
          refreshToken: "sample"
        }
      });
      socketRef.current.on("connect_error", (err) => handleServerError(err));
      socketRef.current.on(`serverAnswer`, (data) => handleServerAnswer(data));
      socketRef.current.on(`serverCandidate`, (data) => handleServerCandidate(data));

      // 1. 로컬 stream 생성 (발표자 브라우저에서 미디어 track 설정)
      if (!selectedMicrophone) throw new Error("마이크를 먼저 선택해 주세요");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: selectedMicrophone }
      });
      mediaStreamRef.current = stream;

      await setupAudioAnalysis(stream);

      // RTCPeerConnection 생성
      pcRef.current = new RTCPeerConnection(pc_config);
      // 발표자의 오디오 트랙을 RTCPeerConnection에 추가
      if (updatedStreamRef.current) {
        updatedStreamRef.current.getTracks().forEach((track) => {
          if (!updatedStreamRef.current || !pcRef.current) return;
          pcRef.current.addTrack(track, updatedStreamRef.current);
        });
      } else {
        console.error("no stream");
      }

      // 서버와 webRTC 연결이 성공했을 때의 동작
      pcRef.current.oniceconnectionstatechange = () => {
        if (pcRef.current?.iceConnectionState === "connected") {
          handleConnected();
        }
      };
    } catch (error) {
      console.error(error);
    }
  };

  async function createPresenterOffer() {
    // 4. 발표자의 offer 생성
    try {
      if (!pcRef.current || !socketRef.current) throw new Error("RTCPeerConnection 또는 소켓 연결 실패");
      const SDP = await pcRef.current.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false
      });
      socketRef.current.emit("presenterOffer", {
        socketId: socketRef.current.id,
        roomId: roomid,
        SDP: SDP
      });
      pcRef.current.setLocalDescription(SDP);
      getPresenterCandidate();
    } catch (error) {
      console.error(error);
    }
  }

  function getPresenterCandidate() {
    // 5. 발표자의 candidate 수집
    if (!pcRef.current) return;
    pcRef.current.onicecandidate = (e) => {
      if (e.candidate && socketRef.current) {
        socketRef.current.emit("clientCandidate", {
          candidate: e.candidate,
          presenterSocketId: socketRef.current.id
        });
      }
    };
  }

  // 사용자에게 입력받은 MediaStream을 분석/변환하여 updatedStream으로 바꿔주는 함수
  const setupAudioAnalysis = (stream: MediaStream) => {
    // Web Audio API에서 오디오를 다루기 위한 기본 객체 AudioContext 생성
    const audioContext = new AudioContext();
    // 오디오 신호를 분석하기 위한 AnalyserNode 객체 생성
    const analyser = audioContext.createAnalyser();
    // 미디어 스트림을 audioContext 내에서 사용할 수 있는 형식으로 변환
    const mediaStreamAudioSourceNode = audioContext.createMediaStreamSource(stream);

    // 입력 오디오 신호의 볼륨을 조절하기 위한 GainNode 객체 생성
    const gainNode = audioContext.createGain();
    // 변환된 미디어 스트림을 GainNode 객체에 연결
    mediaStreamAudioSourceNode.connect(gainNode);
    // GainNode 객체를 AnalyserNode 객체에 연결
    gainNode.connect(analyser);

    // audioContext에서 처리된 오디오로 새로운 미디어 스트림 생성
    const mediaStreamDestination = audioContext.createMediaStreamDestination();
    // gainNode와 새 미디어 스트림 연결
    gainNode.connect(mediaStreamDestination);
    // 업데이트된 미디어 스트림을 앞으로 참조하도록 설정
    updatedStreamRef.current = mediaStreamDestination.stream;

    startTime = Date.now();
    const onFrame = () => {
      saveCanvasData(fabricCanvasRef!, canvasData, startTime).then((isChanged) => {
        if (isChanged) submitData(canvasData);
      });
      gainNode.gain.value = inputMicVolumeRef.current;
      setMicVolumeState(calcNormalizedVolume(analyser));
      onFrameIdRef.current = window.requestAnimationFrame(onFrame);
    };
    onFrameIdRef.current = window.requestAnimationFrame(onFrame);
  };

  let startTime = Date.now();
  // 경과 시간을 표시하기 위한 부분입니다
  const startTimer = () => {
    const updateElapsedTime = () => {
      const elapsedTime = Math.floor((Date.now() - startTime) / 1000);
      setElapsedTime(elapsedTime);
    };
    const timer = setInterval(updateElapsedTime, 1000);
    timerIdRef.current = timer;
  };

  // 기존에 미디어 서버에 보내는 오디오 트랙을 새 마이크의 오디오 트랙으로 교체
  const replaceAudioTrack = async () => {
    try {
      if (!selectedMicrophone) throw new Error("마이크를 먼저 선택해 주세요");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: selectedMicrophone }
      });
      if (mediaStreamRef.current) mediaStreamRef.current.getTracks().forEach((track) => track.stop()); // 기존 미디어 트랙 중지
      mediaStreamRef.current = stream;

      await setupAudioAnalysis(stream);

      if (!updatedStreamRef.current || !pcRef.current) return;
      const newAudioTrack = updatedStreamRef.current.getAudioTracks()[0];
      pcRef.current.getSenders()[0].replaceTrack(newAudioTrack);
    } catch (error) {
      console.error("오디오 replace 작업 실패", error);
    }
  };

  const mute = () => {
    if (isMicOn) {
      prevInputMicVolumeRef.current = inputMicVolumeRef.current;
      setInputMicVolumeState(0);
      setIsMicOn(false);
      showToast({ message: "마이크 음소거 되었습니다.", type: "alert" });
    } else {
      setInputMicVolumeState(prevInputMicVolumeRef.current);
      setIsMicOn(true);
      showToast({ message: "마이크 음소거가 해제되었습니다.", type: "success" });
    }
  };

  let canvasData: ICanvasData = {
    canvasJSON: "",
    viewport: [1, 0, 0, 1, 0, 0],
    eventTime: 0,
    width: 0,
    height: 0
  };
  let replayFileArray: ICanvasData[] = [];

  const submitData = (data: ICanvasData) => {
    if (!lectureSocketRef.current) return;
    lectureSocketRef.current.emit("edit", {
      type: "whiteBoard",
      roomId: roomid,
      content: data
    });
    replayFileArray.push({ ...data });
    console.log(replayFileArray);
  };

  const handleServerAnswer = (data: any) => {
    if (!pcRef.current) return;
    console.log("6. remoteDescription 설정완료");
    pcRef.current.setRemoteDescription(data.SDP);
  };
  const handleServerCandidate = (data: any) => {
    if (!pcRef.current) return;
    console.log("7. 서버로부터 candidate 받음");
    pcRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
  };
  const handleConnected = () => {
    isLectureStartRef.current = true;
    startTime = Date.now();
    startTimer();
    showToast({ message: "강의가 시작되었습니다.", type: "success" });
    if (!managerRef.current) return;
    lectureSocketRef.current = managerRef.current.socket("/lecture", {
      auth: {
        accessToken: localStorage.getItem("token"),
        refreshToken: "sample"
      }
    });
    setInstructorSocket(lectureSocketRef.current);
    submitData(canvasData);
  };
  const handleServerError = (err: any) => {
    console.error(err.message);
    showToast({ message: "서버 연결에 실패했습니다", type: "alert" });
  };
  const handlePopstate = () => {
    stopLecture();
    navigate("/");
    window.removeEventListener("popstate", handlePopstate);
  };

  return (
    <>
      <div className="gap-2 hidden sm:flex home:fixed home:left-1/2 home:-translate-x-1/2">
        <VolumeMeter />
        <p className="semibold-20 text-boarlog-100">{convertMsTohhmm(elapsedTime)}</p>
      </div>

      <SmallButton
        className={`text-grayscale-white ${isLectureStartRef.current ? "bg-alert-100" : "bg-boarlog-100"}`}
        onClick={!isLectureStartRef.current ? () => setIsStartModalOpen(true) : () => setIsCloseModalOpen(true)}
      >
        {isLectureStartRef.current ? (
          <>
            <StopIcon className="w-5 h-5 fill-grayscale-white" />
            <p className="hidden home:block">강의 종료</p>
          </>
        ) : (
          <>
            <PlayIcon className="w-5 h-5 fill-grayscale-white" />
            <p className="hidden home:block">강의 시작</p>
          </>
        )}
      </SmallButton>
      <SmallButton className={`text-grayscale-white ${isMicOn ? "bg-boarlog-100" : "bg-alert-100"}`} onClick={mute}>
        {isMicOn ? (
          <MicOnIcon className="w-5 h-5 fill-grayscale-white" />
        ) : (
          <MicOffIcon className="w-5 h-5 fill-grayscale-white" />
        )}
      </SmallButton>
      <Modal
        modalText="강의를 시작하시겠습니까?"
        cancelText="취소"
        confirmText="강의 시작하기"
        cancelButtonStyle="black"
        confirmButtonStyle="blue"
        confirmClick={startLecture}
        isModalOpen={isStartModalOpen}
        setIsModalOpen={setIsStartModalOpen}
      />
      <Modal
        modalText="강의를 종료하시겠습니까?"
        cancelText="취소"
        confirmText="강의 종료하기"
        cancelButtonStyle="black"
        confirmButtonStyle="red"
        confirmClick={stopLecture}
        isModalOpen={isCloseModalOpen}
        setIsModalOpen={setIsCloseModalOpen}
      />
    </>
  );
};

export default HeaderInstructorControls;
